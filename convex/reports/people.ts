import type { ReaderArgs } from "../analytics/assistantTypes";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import {
  businessDateForInstant,
  type BusinessDaySetting,
} from "../../lib/businessDay";
import { createLiveReadState, readLiveQueryRows } from "../lib/liveQueryBounds";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import {
  assertValidDateRange,
  getUserDisplayName,
} from "../reporting/lib/helpers";
import { requireTenantUser } from "../requireTenantUser";
import { MEMBER_REPORT_ROLES, resolveMemberFilter } from "./lib/access";
import {
  CALL_READ_CAP,
  loadCallFacts,
  readRangeMeetings,
  type CallFacts,
  type CallStatus,
  type CallType,
} from "./lib/callFacts";

import {
  attendanceFields,
  cashValidator,
  callStatusValidator,
  callTypeValidator,
} from "./lib/validators";
import { dealOutcomeValidator } from "../opportunities/stages";

export type CloserCash = {
  currency: string;
  cashMinor: number;
  finalMinor: number;
};
export type CloserRow = {
  userId: Id<"users">;
  teamMemberId: Id<"teamMembers"> | null;
  name: string;
  isActive: boolean;
  due: number;
  held: number;
  noShow: number;
  notRecorded: number;
  moved: number;
  canceled: number;
  firstHeld: number;
  firstNoShow: number;
  firstNotRecorded: number;
  followUpHeld: number;
  followUpNoShow: number;
  recordMinutes: number[];
  cohortDeals: number;
  cohortWon: number;
  dealsWon: number;
  wonDealIds?: Id<"opportunities">[];
  cash: CloserCash[];
  payments: number;
};
export type CloserDay = {
  dayKey: string;
  held: number;
  noShow: number;
  notRecorded: number;
  cashMinorByCurrency: Array<{ currency: string; cashMinor: number }>;
};
export type CloserCall = {
  meetingId: Id<"meetings">;
  opportunityId: Id<"opportunities">;
  scheduledAt: number;
  leadName: string;
  programName: string;
  status: CallStatus;
  callType: CallType;
  dealOutcome: Doc<"opportunities">["outcome"] | null;
  paidMinor: Array<{ currency: string; paidMinor: number }>;
};
export type PeopleClosers = {
  rows: CloserRow[];
  firstPaymentDealIds?: Id<"opportunities">[];
  unattributedCash: CloserCash[];
  days: CloserDay[];
  calls: CloserCall[];
  callsPartial: boolean;
  partial: boolean;
  cohortPartial: boolean;
  paymentsPartial: boolean;
};
export type CloserCohort = { meetingId: Id<"meetings">; won: boolean };
export type PeopleCloserInput = CallFacts & {
  users: Doc<"users">[];
  payments: Doc<"paymentRecords">[];
  callPayments: Doc<"paymentRecords">[];
  cohort: CloserCohort[];
  firstPaymentIds: Id<"paymentRecords">[];
  firstPaymentDealIds?: Id<"opportunities">[];
  cohortPartial: boolean;
  paymentsPartial: boolean;
};

export function addCash(rows: CloserCash[], payment: Doc<"paymentRecords">) {
  let row = rows.find((r) => r.currency === payment.currency);
  if (!row) {
    row = { currency: payment.currency, cashMinor: 0, finalMinor: 0 };
    rows.push(row);
  }
  row.cashMinor += payment.amountMinor;
  if (payment.paymentType !== "deposit") row.finalMinor += payment.amountMinor;
}
const sortCash = (cash: CloserCash[]) =>
  cash.sort((a, b) => a.currency.localeCompare(b.currency));

export function buildPeopleClosers(
  input: PeopleCloserInput,
  memberId: Id<"teamMembers"> | null,
  setting: BusinessDaySetting,
): PeopleClosers {
  const users = new Map(input.users.map(u => [u._id, u]));
  const selected = (id: Id<"users">) => !memberId || users.get(id)?.teamMemberId === memberId;
  const payments = input.payments.filter(p => p.status !== "disputed");
  const byId = new Map<Id<"users">, CloserTotals>();
  const getRow = (userId: Id<"users">) => {
    let row = byId.get(userId);
    if (!row) { row = emptyCloserTotals(userId); byId.set(userId, row); }
    return row;
  };
  const days = new Map<string, CloserDay>();
  const getDay = (at: number) => {
    const dayKey = businessDateForInstant(at, setting);
    const row = days.get(dayKey) ?? {
      dayKey,
      held: 0,
      noShow: 0,
      notRecorded: 0,
      cashMinorByCurrency: [],
    };
    days.set(dayKey, row);
    return row;
  };
  const paidByMeeting = new Map<Id<"meetings">, CloserCash[]>();
  if (memberId)
    for (const p of input.callPayments) {
      if (p.status === "disputed" || !p.meetingId) continue;
      const paid = paidByMeeting.get(p.meetingId) ?? [];
      addCash(paid, p);
      paidByMeeting.set(p.meetingId, paid);
    }
  const calls: CloserCall[] = [];
  const cohort = new Map(input.cohort.map((c) => [c.meetingId, c]));
  for (const fact of input.facts) {
    const row = getRow(fact.closerId);
    if (fact.due) row.due++;
    const key =
      fact.status === "held"
        ? "held"
        : fact.status === "no_show"
          ? "noShow"
          : fact.status === "not_recorded"
            ? "notRecorded"
            : fact.status === "canceled"
              ? "canceled"
              : fact.status === "moved"
                ? "moved"
                : null;
    if (key) row[key]++;
    if (fact.callType === "new") {
      if (fact.status === "held") row.firstHeld++;
      if (fact.status === "no_show") row.firstNoShow++;
      if (fact.status === "not_recorded") row.firstNotRecorded++;
    } else {
      if (fact.status === "held") row.followUpHeld++;
      if (fact.status === "no_show") row.followUpNoShow++;
    }
    if (fact.status !== "moved" && fact.recordMinutes !== null)
      row.recordMinutes.push(fact.recordMinutes);
    const c = cohort.get(fact.meeting._id);
    if (c) {
      row.cohortDeals++;
      if (c.won) row.cohortWon++;
    }
    if (memberId && selected(fact.closerId)) {
      const day = getDay(fact.meeting.scheduledAt);
      if (key === "held" || key === "noShow" || key === "notRecorded")
        day[key]++;
      const paid = paidByMeeting.get(fact.meeting._id) ?? [];
      calls.push({
        meetingId: fact.meeting._id,
        opportunityId: fact.meeting.opportunityId,
        scheduledAt: fact.meeting.scheduledAt,
        leadName: fact.leadName,
        programName: fact.programName,
        status: fact.status,
        callType: fact.callType,
        dealOutcome: fact.dealOutcome,
        paidMinor: sortCash(paid).map((p) => ({
          currency: p.currency,
          paidMinor: p.cashMinor,
        })),
      });
    }
  }
  const first = new Set(input.firstPaymentIds);
  const unattributedCash: CloserCash[] = [];
  for (const p of payments) {
    if (!p.attributedCloserId) {
      if (!memberId) addCash(unattributedCash, p);
      continue;
    }
    const row = getRow(p.attributedCloserId);
    row.payments++;
    addCash(row.cash, p);
    if (p.opportunityId && first.has(p._id)) {
      row.dealsWon++;
      row.wonDealIds!.push(p.opportunityId);
    }
    if (memberId && selected(p.attributedCloserId)) {
      const day = getDay(p.recordedAt);
      const cash = day.cashMinorByCurrency.find(
        (c) => c.currency === p.currency,
      );
      if (cash) cash.cashMinor += p.amountMinor;
      else
        day.cashMinorByCurrency.push({
          currency: p.currency,
          cashMinor: p.amountMinor,
        });
    }
  }
  return finishPeopleClosers({
    users: input.users, totals: [...byId.values()], unattributedCash,
    days: [...days.values()], calls,
    // Raw reference SQL has no lifetime participation projection, so it omits
    // this optional metadata. The live reader supplies the privacy-filtered set.
    firstPaymentDealIds: input.firstPaymentDealIds,
    partial: input.partial, cohortPartial: input.cohortPartial, paymentsPartial: input.paymentsPartial,
  }, memberId);
}

export type CloserTotals = Omit<CloserRow, "teamMemberId" | "name" | "isActive">;
export function emptyCloserTotals(userId: Id<"users">): CloserTotals {
  return {
    userId, due: 0, held: 0, noShow: 0, notRecorded: 0, moved: 0, canceled: 0,
    firstHeld: 0, firstNoShow: 0, firstNotRecorded: 0, followUpHeld: 0, followUpNoShow: 0,
    recordMinutes: [], cohortDeals: 0, cohortWon: 0, dealsWon: 0, wonDealIds: [], cash: [], payments: 0,
  };
}
export type PeopleCloserFinishInput = Omit<PeopleClosers, "rows" | "callsPartial"> & {
  users: Doc<"users">[];
  totals: CloserTotals[];
  callsPartial?: boolean;
};

/** Shared by live facts and SQL aggregates. No meeting/payment documents needed. */
export function finishPeopleClosers(input: PeopleCloserFinishInput, memberId: Id<"teamMembers"> | null): PeopleClosers {
  const users = new Map(input.users.map(u => [u._id, u]));
  const totals = new Map(input.totals.map(row => [row.userId, row]));
  for (const user of input.users) if (user.role === "closer" && !totals.has(user._id))
    totals.set(user._id, emptyCloserTotals(user._id));
  const rows: CloserRow[] = [];
  for (const row of totals.values()) {
    const user = users.get(row.userId);
    if (memberId && user?.teamMemberId !== memberId) continue;
    rows.push({ ...row, cash: sortCash(row.cash),
      ...(row.wonDealIds ? { wonDealIds: [...new Set(row.wonDealIds)].sort() } : {}),
      teamMemberId: user?.teamMemberId ?? null,
      name: user ? getUserDisplayName(user) : "Removed closer",
      isActive: !!user?.isActive && user.deletedAt === undefined });
  }
  for (const day of input.days) day.cashMinorByCurrency.sort((a, b) => a.currency.localeCompare(b.currency));
  const calls = input.calls.sort((a, b) => b.scheduledAt - a.scheduledAt || a.meetingId.localeCompare(b.meetingId));
  return {
    rows: rows.sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId)),
    ...(input.firstPaymentDealIds ? { firstPaymentDealIds: [...new Set(input.firstPaymentDealIds)].sort() } : {}),
    unattributedCash: sortCash(input.unattributedCash),
    days: input.days.sort((a, b) => a.dayKey.localeCompare(b.dayKey)),
    calls: calls.slice(0, 300), callsPartial: !!input.callsPartial || calls.length > 300 || input.partial,
    partial: input.partial, cohortPartial: input.cohortPartial, paymentsPartial: input.paymentsPartial,
  };
}

/** Load only small current dimensions, including former closers seen in facts. */
export async function loadCloserUsers(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  facts: CallFacts,
  payments: Doc<"paymentRecords">[],
  source: "live" | "warehouse" = "live",
) {
  if (source === "warehouse") {
    const roster = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(501);
    if (roster.length > 500)
      throw new Error("The closer roster exceeds the report limit.");
    const byId = new Map(roster.map((u) => [u._id, u]));
    const seen = new Set([
      ...facts.facts.map((f) => f.closerId),
      ...payments.flatMap((p) =>
        p.attributedCloserId ? [p.attributedCloserId] : [],
      ),
    ]);
    const missing = [...seen].filter((id) => !byId.has(id));
    const users = await Promise.all(
      missing.map((id) => ctx.db.get("users", id)),
    );
    for (const u of users) if (u?.tenantId === tenantId) byId.set(u._id, u);
    return { users: [...byId.values()], partial: false };
  }
  const roster = await readLiveQueryRows(
    ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)),
    500,
  );
  const byId = new Map(roster.rows.map((u) => [u._id, u]));
  const seen = new Set([
    ...facts.facts.map((f) => f.closerId),
    ...payments.flatMap((p) =>
      p.attributedCloserId ? [p.attributedCloserId] : [],
    ),
  ]);
  if (seen.size > 500) return { users: roster.rows, partial: true };
  const missing = [...seen].filter((id) => !byId.has(id));
  // Reserve index ranges for cohort and first-payment lookups in this query.
  for (const id of missing.slice(0, 100)) {
    const u = await ctx.db.get("users", id);
    if (u?.tenantId === tenantId) byId.set(id, u);
  }
  return {
    users: [...byId.values()],
    partial: roster.capped || missing.length > 100,
  };
}

export async function readCloserCohort(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  facts: CallFacts,
): Promise<{ cohort: CloserCohort[]; partial: boolean }> {
  const cohort: CloserCohort[] = [];
  const deals = [
    ...new Set(
      facts.facts
        .filter((f) => f.meeting.status === "held")
        .map((f) => f.meeting.opportunityId),
    ),
  ];
  for (const id of deals) {
    const first = await ctx.db
      .query("meetings")
      .withIndex("by_opportunityId_and_status_and_scheduledAt", (q) =>
        q.eq("opportunityId", id).eq("status", "held"),
      )
      .first();
    if (
      !first ||
      first.tenantId !== tenantId ||
      !facts.facts.some((f) => f.meeting._id === first._id)
    )
      continue;
    const deal = await ctx.db.get("opportunities", id);
    if (deal?.tenantId === tenantId)
      cohort.push({ meetingId: first._id, won: deal.outcome === "won" });
  }
  return { cohort: facts.partial ? [] : cohort, partial: facts.partial };
}

export async function readFirstPayments(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  payments: Doc<"paymentRecords">[],
) {
  const first: Id<"paymentRecords">[] = [];
  for (const id of new Set(
    payments.flatMap((p) => (p.opportunityId ? [p.opportunityId] : [])),
  )) {
    const candidates = await Promise.all(
      (["recorded", "verified"] as const).map((status) =>
        ctx.db
          .query("paymentRecords")
          .withIndex("by_opportunityId_and_status_and_recordedAt", (q) =>
            q.eq("opportunityId", id).eq("status", status),
          )
          .first(),
      ),
    );
    const payment = candidates
      .filter((p): p is Doc<"paymentRecords"> => p?.tenantId === tenantId)
      .sort(
        (a, b) =>
          a.recordedAt - b.recordedAt ||
          a._creationTime - b._creationTime ||
          a._id.localeCompare(b._id),
      )[0];
    if (payment) first.push(payment._id);
  }
  return first;
}

/** A call's linked payments are lifetime amounts; report cash stays in range. */
export async function readCallPayments(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  facts: CallFacts,
) {
  const state = createLiveReadState();
  const payments: Doc<"paymentRecords">[] = [];
  for (const id of new Set(facts.facts.map((f) => f.meeting.opportunityId))) {
    const scan = await readLiveQueryRows(
      ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId_and_recordedAt", (q) =>
          q.eq("opportunityId", id),
        ),
      CALL_READ_CAP,
      state,
    );
    payments.push(
      ...scan.rows.filter(
        (p) => p.tenantId === tenantId && p.status !== "disputed",
      ),
    );
    if (scan.capped) break;
  }
  return { payments, partial: state.capped };
}

export const peopleClosersValidator = v.object({
  firstPaymentDealIds: v.optional(v.array(v.id("opportunities"))),
  rows: v.array(
    v.object({
      userId: v.id("users"),
      teamMemberId: v.union(v.id("teamMembers"), v.null()),
      name: v.string(),
      isActive: v.boolean(),
      due: v.number(),
      ...attendanceFields,
      moved: v.number(),
      canceled: v.number(),
      firstHeld: v.number(),
      firstNoShow: v.number(),
      firstNotRecorded: v.number(),
      followUpHeld: v.number(),
      followUpNoShow: v.number(),
      recordMinutes: v.array(v.number()),
      cohortDeals: v.number(),
      cohortWon: v.number(),
      dealsWon: v.number(),
      wonDealIds: v.optional(v.array(v.id("opportunities"))),
      cash: v.array(cashValidator),
      payments: v.number(),
    }),
  ),
  unattributedCash: v.array(cashValidator),
  days: v.array(
    v.object({
      dayKey: v.string(),
      ...attendanceFields,
      cashMinorByCurrency: v.array(
        v.object({ currency: v.string(), cashMinor: v.number() }),
      ),
    }),
  ),
  calls: v.array(
    v.object({
      meetingId: v.id("meetings"),
      opportunityId: v.id("opportunities"),
      scheduledAt: v.number(),
      leadName: v.string(),
      programName: v.string(),
      status: callStatusValidator,
      callType: callTypeValidator,
      dealOutcome: v.union(dealOutcomeValidator, v.null()),
      paidMinor: v.array(
        v.object({ currency: v.string(), paidMinor: v.number() }),
      ),
    }),
  ),
  callsPartial: v.boolean(),
  partial: v.boolean(),
  cohortPartial: v.boolean(),
  paymentsPartial: v.boolean(),
});

export const getPeopleClosers = query({
  returns: peopleClosersValidator,
  args: {
    // A minute clock from the page makes time-only changes reactive.
    asOf: v.optional(v.number()),
    startDate: v.number(),
    endDate: v.number(),
    memberId: v.optional(v.id("teamMembers")),
  },
  handler: async (ctx, args): Promise<PeopleClosers> => {
    const viewer = await requireTenantUser(ctx, [...MEMBER_REPORT_ROLES]);
    const memberId = await resolveMemberFilter(ctx, args.memberId, viewer);
    return readPeopleClosers(ctx, viewer.tenantId, args, memberId);
  },
});

/** Shared load/build path. Trusted callers must authorize the tenant first. */
export async function readPeopleClosers(ctx: QueryCtx, tenantId: Id<"tenants">, args: ReaderArgs<typeof getPeopleClosers>, memberId: Id<"teamMembers"> | null): Promise<PeopleClosers> {
  assertValidDateRange(args.startDate, args.endDate);
  const meetings = await readRangeMeetings(
    ctx,
    tenantId,
    args.startDate,
    args.endDate,
  );
  const loaded = await loadCallFacts(
    ctx,
    tenantId,
    meetings.rows,
    args.asOf ?? Date.now(),
  );
  const facts = {
    facts: loaded.facts,
    partial: loaded.partial || meetings.capped,
  };
  const payments = await readLiveQueryRows(
    ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_recordedAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("recordedAt", args.startDate)
          .lt("recordedAt", args.endDate),
      ),
    CALL_READ_CAP,
  );
  const eligible = payments.rows.filter((p) => p.status !== "disputed");
  const users = await loadCloserUsers(ctx, tenantId, facts, eligible);
  const cohort = await readCloserCohort(ctx, tenantId, facts);
  const callPayments = memberId
    ? await readCallPayments(ctx, tenantId, facts)
    : { payments: [], partial: false };
  const firstPaymentIds = await readFirstPayments(ctx, tenantId, eligible);
  const first = new Set(firstPaymentIds);
  let firstPaymentDealIds = eligible.flatMap(p => p.opportunityId && first.has(p._id) ? [p.opportunityId] : []);
  const participationState = createLiveReadState();
  if (memberId) {
    const userIds = new Set(users.users.filter(u => u.teamMemberId === memberId).map(u => u._id));
    const participated: Id<"opportunities">[] = [];
    for (const id of firstPaymentDealIds) {
      const history = await readLiveQueryRows(ctx.db.query("paymentRecords")
        .withIndex("by_opportunityId_and_recordedAt", q => q.eq("opportunityId", id)), CALL_READ_CAP, participationState);
      if (history.rows.some(p => p.tenantId === tenantId && p.attributedCloserId && userIds.has(p.attributedCloserId))) participated.push(id);
      if (history.capped) break;
    }
    firstPaymentDealIds = participated;
  }
  return buildPeopleClosers(
    {
      ...facts,
      partial: facts.partial || users.partial || callPayments.partial || participationState.capped,
      users: users.users,
      payments: eligible,
      callPayments: callPayments.payments,
      cohort: cohort.cohort,
      firstPaymentIds,
      firstPaymentDealIds,
      cohortPartial: cohort.partial,
      paymentsPartial: payments.capped,
    },
    memberId,
    await getTenantBusinessDay(ctx, tenantId),
  );
}
