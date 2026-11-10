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
  const ids = new Set<Id<"users">>(
    input.users.filter((u) => u.role === "closer").map((u) => u._id),
  );
  input.facts.forEach((f) => ids.add(f.closerId));
  const payments = input.payments.filter((p) => p.status !== "disputed");
  payments.forEach((p) => {
    if (p.attributedCloserId) ids.add(p.attributedCloserId);
  });
  const users = new Map(input.users.map((u) => [u._id, u]));
  const byId = new Map<Id<"users">, CloserRow>();
  for (const userId of ids) {
    const u = users.get(userId);
    if (memberId && u?.teamMemberId !== memberId) continue;
    byId.set(userId, {
      userId,
      teamMemberId: u?.teamMemberId ?? null,
      name: u ? getUserDisplayName(u) : "Removed closer",
      isActive: !!u?.isActive && u.deletedAt === undefined,
      due: 0,
      held: 0,
      noShow: 0,
      notRecorded: 0,
      moved: 0,
      canceled: 0,
      firstHeld: 0,
      firstNoShow: 0,
      firstNotRecorded: 0,
      followUpHeld: 0,
      followUpNoShow: 0,
      recordMinutes: [],
      cohortDeals: 0,
      cohortWon: 0,
      dealsWon: 0,
      cash: [],
      payments: 0,
    });
  }
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
    const row = byId.get(fact.closerId);
    if (!row) continue;
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
    if (memberId) {
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
    const row = byId.get(p.attributedCloserId);
    if (!row) continue;
    row.payments++;
    addCash(row.cash, p);
    if (p.opportunityId && first.has(p._id)) row.dealsWon++;
    if (memberId) {
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
  byId.forEach((r) => sortCash(r.cash));
  days.forEach((d) =>
    d.cashMinorByCurrency.sort((a, b) => a.currency.localeCompare(b.currency)),
  );
  calls.sort(
    (a, b) =>
      b.scheduledAt - a.scheduledAt || a.meetingId.localeCompare(b.meetingId),
  );
  return {
    rows: [...byId.values()].sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId),
    ),
    unattributedCash: sortCash(unattributedCash),
    days: [...days.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey)),
    calls: calls.slice(0, 300),
    callsPartial: calls.length > 300 || input.partial,
    partial: input.partial,
    cohortPartial: input.cohortPartial,
    paymentsPartial: input.paymentsPartial,
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
  return buildPeopleClosers(
    {
      ...facts,
      partial: facts.partial || users.partial || callPayments.partial,
      users: users.users,
      payments: eligible,
      callPayments: callPayments.payments,
      cohort: cohort.cohort,
      firstPaymentIds: await readFirstPayments(
        ctx,
        tenantId,
        eligible,
      ),
      cohortPartial: cohort.partial,
      paymentsPartial: payments.capped,
    },
    memberId,
    await getTenantBusinessDay(ctx, tenantId),
  );
}
