import type { TestConvex } from "convex-test";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import type schema from "../convex/schema";
import { listPersonEnrollments } from "../convex/enrollments/read";
import { derivePersonEnrollments, earliestCountingPayment, paymentCounts, syncPersonEnrollments } from "../convex/lib/enrollments";
import { transitionOpportunity } from "../convex/lib/opportunityActivity";
import { refreshSoldProgramCachesForOpportunity } from "../convex/lib/soldProgramCache";
import { dealPosition } from "../convex/opportunities/stages";
import { replacePaymentAggregate } from "../convex/reporting/writeHooks";
import { clearActiveAllocation, setActiveAllocation } from "../convex/payments/allocation";
import { clearAttendanceOwed, markAttendanceOwed } from "../convex/payments/attendanceDebt";
import { seedProviderRow } from "./providerRowFixtures";

// I8 and I11 are about losses an exclusion wrote, not every reserved code.
const isPaymentExcludedLoss = (reason: string | undefined) => reason === "payment_excluded";

// The sixteen payment invariants of the phase 2 build contract (§4). Every
// phase 2 backend test calls `assertPaymentInvariants` after each step. It
// reads every row in scope inside one `t.run` and throws one error listing
// each broken invariant with ids. Test-only: reads are bounded, and past a
// bound it throws rather than check part of a range.

export const INVARIANT_IDS = [
  "I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8",
  "I9", "I10", "I11", "I12", "I13", "I14", "I15", "I16",
] as const;
export type InvariantId = (typeof INVARIANT_IDS)[number];

export type InvariantScope = {
  tenantId: Id<"tenants">;
  opportunityIds?: Id<"opportunities">[];
  providerPaymentIds?: Id<"providerPayments">[];
};

const SCOPE_LIMIT = 200;
const ROWS_PER_DEAL_LIMIT = 100;
const STORED_ROWS_PER_DEAL = 40;
const MEETINGS_PER_DEAL_LIMIT = 50;
const PENDING_TASK_LIMIT = 20;
const ROW_LIST_LIMIT = 500;

const DECISION_STATES = [
  "shadow", "needs_person", "ready", "applied", "stopped", "superseded", "blocked", "undone", "corrected",
] as const;
const NEW_EVENT_TYPES = [
  "payment.restored", "payment.flagged_not_my_sale", "payment.not_my_sale_cleared", "automation.settings_changed",
] as const;
const ALLOWED_STRINGS = [
  /^[a-z_]+$/, // fixed codes
  /^[A-Z]{3}$/, // ISO currency
  /^[0-9a-f]{64}$/, // sha256 hex
  /^payment-rule@\d+$/, // rule version
  /^\d+[A-Za-z]+$/, // ids in convex-test (a counter, then the table)
  /^[0-9a-z]{31,37}$/, // ids on a deployment
];

type Violation = { id: InvariantId; detail: string };
type Attendance = Pick<Doc<"meetings">, "status" | "heldMarkedAt" | "noShowMarkedAt" | "attendanceDecisionId">;

// I6 compares each held or no-show meeting with how the previous call saw it.
const attendanceSeen = new WeakMap<object, Map<string, Attendance>>();

function overflow(what: string, limit: number): never {
  throw new Error(`assertPaymentInvariants: more than ${limit} ${what} in scope`);
}

async function bounded<T>(rows: Promise<T[]>, limit: number, what: string): Promise<T[]> {
  const list = await rows;
  if (list.length > limit) overflow(what, limit);
  return list;
}

function stringsIn(value: unknown, path: string, out: Array<[string, string]>) {
  if (typeof value === "string") out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((item, index) => stringsIn(item, `${path}[${index}]`, out));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) stringsIn(item, `${path}.${key}`, out);
  }
}

function freeText(value: unknown): Array<[string, string]> {
  const strings: Array<[string, string]> = [];
  stringsIn(value, "", strings);
  return strings.filter(([, text]) => !ALLOWED_STRINGS.some((pattern) => pattern.test(text)));
}

async function collect(
  ctx: QueryCtx,
  scope: InvariantScope,
  seen: Map<string, Attendance>,
): Promise<{ violations: Violation[]; attendance: Array<[Id<"meetings">, Attendance]> }> {
  const { tenantId } = scope;
  const violations: Violation[] = [];
  const fail = (id: InvariantId, detail: string) => violations.push({ id, detail });

  const deals = scope.opportunityIds
    ? (await Promise.all(scope.opportunityIds.map((id) => ctx.db.get("opportunities", id))))
      .flatMap((deal) => deal && deal.tenantId === tenantId ? [deal] : [])
    : await bounded(ctx.db.query("opportunities").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(SCOPE_LIMIT + 1), SCOPE_LIMIT, "deals");
  const dealIds = new Set<string>(deals.map((deal) => deal._id));

  const rowsByDeal = new Map<string, Doc<"paymentRecords">[]>();
  const rowsById = new Map<string, Doc<"paymentRecords">>();
  for (const deal of deals) {
    const rows = await bounded(ctx.db.query("paymentRecords")
      .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", deal._id))
      .take(ROWS_PER_DEAL_LIMIT + 1), ROWS_PER_DEAL_LIMIT, "rows on one deal");
    rowsByDeal.set(deal._id, rows);
    for (const row of rows) rowsById.set(row._id, row);
  }

  const paymentIds = new Set<Id<"providerPayments">>(scope.providerPaymentIds ?? []);
  if (!scope.providerPaymentIds) {
    const all = await bounded(ctx.db.query("providerPayments")
      .withIndex("by_tenantId_and_connectionId_and_externalPaymentId", (q) => q.eq("tenantId", tenantId))
      .take(SCOPE_LIMIT + 1), SCOPE_LIMIT, "provider payments");
    for (const payment of all) paymentIds.add(payment._id);
  }
  for (const row of rowsById.values()) if (row.providerPaymentId) paymentIds.add(row.providerPaymentId);
  const payments = (await Promise.all([...paymentIds].map((id) => ctx.db.get("providerPayments", id))))
    .flatMap((payment) => payment ? [payment] : []);

  // I3, I4: one active allocation, both ways.
  for (const payment of payments) {
    const pointer = payment.paymentRecordId;
    if (pointer) {
      const row = await ctx.db.get("paymentRecords", pointer);
      if (!row || row.tenantId !== payment.tenantId) fail("I3", `${payment._id} points at missing or other-tenant row ${pointer}`);
      else {
        if (row.providerPaymentId !== payment._id) fail("I3", `${payment._id} points at ${row._id}, which cites ${row.providerPaymentId ?? "nothing"}`);
        if (!paymentCounts(row)) fail("I3", `${payment._id} points at disputed row ${row._id}`);
      }
      if (payment.reviewState !== "linked" && payment.reviewState !== "recorded") {
        fail("I3", `${payment._id} has a pointer but review state ${payment.reviewState}`);
      }
    } else if (payment.reviewState === "linked" || payment.reviewState === "recorded") {
      fail("I4", `${payment._id} has no pointer but review state ${payment.reviewState}`);
    }
    const citing = await bounded(ctx.db.query("paymentRecords")
      .withIndex("by_tenantId_and_providerPaymentId", (q) =>
        q.eq("tenantId", payment.tenantId).eq("providerPaymentId", payment._id))
      .take(ROW_LIST_LIMIT + 1), ROW_LIST_LIMIT, "rows citing one provider payment");
    const counting = citing.filter(paymentCounts);
    if (counting.length > 1) fail("I3", `${payment._id} has ${counting.length} counting rows: ${counting.map((row) => row._id).join(", ")}`);
    for (const row of counting) {
      if (row._id !== pointer) fail("I3", `counting row ${row._id} cites ${payment._id}, whose pointer is ${pointer ?? "unset"}`);
    }
  }

  // I5: provider provenance, and a person on every row except an applied
  // automatic write's (phase 3 contract §5, A9).
  for (const row of rowsById.values()) {
    if ((row.origin === "provider") !== (row.recordedVia === "provider")) {
      fail("I5", `row ${row._id} has origin ${row.origin} and recordedVia ${row.recordedVia ?? "unset"}`);
    }
    if (row.origin === "provider" && !row.providerPaymentId) fail("I5", `provider row ${row._id} cites no provider payment`);
    if (!row.recordedByUserId) {
      const decision = row.automationDecisionId
        ? await ctx.db.get("resultAutomationDecisions", row.automationDecisionId) : null;
      if (row.origin !== "provider" || decision?.tenantId !== row.tenantId || decision.state !== "applied" ||
          decision.mode !== "automatic") {
        fail("I5", `row ${row._id} has no recorder`);
      }
    }
  }

  // Plain values: t.run returns Convex values only.
  const attendance: Array<[Id<"meetings">, Attendance]> = [];
  const leadIds = new Set<Id<"leads">>();
  for (const deal of deals) {
    leadIds.add(deal.leadId);
    const rows = rowsByDeal.get(deal._id) ?? [];
    const counting = rows.filter((row) => row.tenantId === tenantId && paymentCounts(row));
    const won = deal.stage === "closed" && deal.outcome === "won";
    const position = dealPosition(deal.stage, deal.outcome);

    // I1, I2: won exactly when money counts, from the first counting payment.
    if (won !== counting.length > 0) fail("I1", `deal ${deal._id} is ${position} with ${counting.length} counting payments`);
    if (won) {
      const first = Math.min(...counting.map((row) => row.recordedAt));
      if (counting.length > 0 && deal.paymentReceivedAt !== first) {
        fail("I2", `deal ${deal._id} paymentReceivedAt ${deal.paymentReceivedAt ?? "unset"}, first counting payment ${first}`);
      }
    } else if (deal.paymentReceivedAt !== undefined) {
      fail("I2", `deal ${deal._id} is ${position} with paymentReceivedAt ${deal.paymentReceivedAt}`);
    }

    // I10: the sold program is the latest counting payment's.
    if (counting.length === 0) {
      if (deal.soldProgramId !== undefined) fail("I10", `deal ${deal._id} has sold program ${deal.soldProgramId} and no counting payment`);
    } else {
      const latest = Math.max(...counting.map((row) => row.recordedAt));
      const programs = counting.filter((row) => row.recordedAt === latest).map((row) => row.programId);
      if (!deal.soldProgramId || !programs.includes(deal.soldProgramId)) {
        fail("I10", `deal ${deal._id} sold program ${deal.soldProgramId ?? "unset"}, latest counting payment's ${programs.join("/")}`);
      }
    }

    // I13: phase 2 never stores a 41st row on a deal.
    if (rows.length > STORED_ROWS_PER_DEAL) fail("I13", `deal ${deal._id} has ${rows.length} stored rows`);

    const meetings = await bounded(ctx.db.query("meetings")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", deal._id))
      .take(MEETINGS_PER_DEAL_LIMIT + 1), MEETINGS_PER_DEAL_LIMIT, "meetings on one deal");

    // I6: payment corrections leave attendance alone. Only a call receipt
    // that actually wrote a held mark may withdraw its own attendance.
    for (const meeting of meetings) {
      const before = seen.get(meeting._id);
      if (before && (before.status !== meeting.status || before.heldMarkedAt !== meeting.heldMarkedAt ||
          before.noShowMarkedAt !== meeting.noShowMarkedAt)) {
        const receipt = before.status === "held" && meeting.status === "scheduled" && before.attendanceDecisionId &&
          !meeting.attendanceDecisionId && !meeting.attendanceSource && meeting.heldMarkedAt === undefined
          ? await ctx.db.get("resultAutomationDecisions", before.attendanceDecisionId)
          : null;
        if (receipt?.state === "undone" && receipt.tenantId === tenantId &&
            receipt.meetingId === meeting._id && receipt.opportunityId === deal._id &&
            receipt.callBefore?.meetingId === meeting._id &&
            (receipt.kind === "call_back" || receipt.kind === "payment_owed")) {
          attendance.push([meeting._id, { status: "scheduled" }]);
        } else {
          fail("I6", `meeting ${meeting._id} was ${before.status} and is now ${meeting.status}, or its marked time moved`);
        }
      }
      if (meeting.status === "held" || meeting.status === "no_show") {
        const { status, heldMarkedAt, noShowMarkedAt, attendanceDecisionId } = meeting;
        attendance.push([meeting._id, { status, heldMarkedAt, noShowMarkedAt, attendanceDecisionId }]);
      }
    }

    // I7: a Booked deal's current booking is scheduled.
    const current = meetings.reduce<Doc<"meetings"> | undefined>(
      (latest, meeting) => !latest || meeting._creationTime > latest._creationTime ? meeting : latest, undefined);
    if (position === "booked" && current && current.status !== "scheduled") {
      fail("I7", `Booked deal ${deal._id} has current meeting ${current._id} ${current.status}`);
    }

    // I15: attendance owed on every scheduled meeting of a Whop-won deal, and visible nowhere else.
    const firstCounting = earliestCountingPayment(counting);
    for (const meeting of meetings) {
      if (meeting.status !== "scheduled") continue;
      if (won && firstCounting?.origin === "provider" && meeting.attendanceOwedSince === undefined) {
        fail("I15", `meeting ${meeting._id} on Whop-won deal ${deal._id} owes no attendance`);
      }
      if (won && counting.length === 0 && meeting.attendanceOwedSince !== undefined) {
        fail("I15", `meeting ${meeting._id} shows attendance owed on deal ${deal._id} with no counting payment`);
      }
    }

    const corrections = await bounded(ctx.db.query("paymentCorrections")
      .withIndex("by_tenantId_and_opportunityId_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("opportunityId", deal._id))
      .take(ROW_LIST_LIMIT + 1), ROW_LIST_LIMIT, "corrections on one deal");

    // I8: the reserved loss exists only where an exclusion wrote it.
    if (isPaymentExcludedLoss(deal.lostReason)) {
      const owner = corrections.some((correction) => correction.operation === "exclude" &&
        correction.result === "lost" && correction.after.lostAt === deal.lostAt);
      if (!owner || deal.lostReason !== "payment_excluded") {
        fail("I8", `deal ${deal._id} lost with ${deal.lostReason} at ${deal.lostAt ?? "unset"} and no exclusion that wrote it`);
      }
    }

    // I11: one next step on an open deal; exactly one after an exclusion reopened it; none restored on its loss.
    const pending = (await bounded(ctx.db.query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) =>
        q.eq("opportunityId", deal._id).eq("status", "pending"))
      .take(PENDING_TASK_LIMIT + 1), PENDING_TASK_LIMIT, "pending tasks on one deal"))
      .filter((task) => task.reason !== "stale_opportunity_nudge");
    if (deal.outcome === "open" && pending.length > 1) fail("I11", `open deal ${deal._id} has ${pending.length} pending tasks`);
    const latestCorrection = corrections.at(-1);
    if (deal.outcome === "open" && latestCorrection?.operation === "exclude" &&
        (latestCorrection.result === "follow_up" || latestCorrection.result === "undo_follow_up") &&
        latestCorrection.after.dealPosition === position &&
        latestCorrection.after.humanResultRevision === (deal.humanResultRevision ?? 0) && pending.length !== 1) {
      fail("I11", `deal ${deal._id} reopened by correction ${latestCorrection._id} has ${pending.length} pending tasks`);
    }
    if (position === "lost" && isPaymentExcludedLoss(deal.lostReason) && pending.length > 0) {
      fail("I11", `deal ${deal._id} closed by an exclusion has ${pending.length} pending tasks`);
    }

    // I12: an enabled membership binding's anchor counts through its payment.
    const bindings = await bounded(ctx.db.query("paymentProviderBindings")
      .withIndex("by_tenantId_and_opportunityId_and_kind", (q) =>
        q.eq("tenantId", tenantId).eq("opportunityId", deal._id).eq("kind", "membership_deal"))
      .take(ROW_LIST_LIMIT + 1), ROW_LIST_LIMIT, "membership bindings on one deal");
    for (const binding of bindings) {
      if (!binding.enabled || binding.binding.kind !== "membership_deal") continue;
      const anchor = await ctx.db.get("paymentRecords", binding.binding.anchorPaymentRecordId);
      const payment = anchor?.providerPaymentId ? await ctx.db.get("providerPayments", anchor.providerPaymentId) : null;
      if (!anchor || !paymentCounts(anchor) || !payment || payment.paymentRecordId !== anchor._id ||
          payment.membershipId !== binding.externalId) {
        fail("I12", `binding ${binding._id} is enabled on anchor ${binding.binding.anchorPaymentRecordId}, which is not its payment's counting pointer`);
      }
    }

    // I16: corrections hold ids, codes and digests only.
    for (const correction of corrections) {
      for (const [path, text] of freeText(correction)) fail("I16", `correction ${correction._id}${path} holds "${text}"`);
    }
  }

  // I9: enrollments derive from counting payments; converted exactly when enrolled.
  for (const leadId of leadIds) {
    const lead = await ctx.db.get("leads", leadId);
    if (!lead || lead.status === "merged") continue;
    const derived = await derivePersonEnrollments(ctx, tenantId, leadId);
    const stored = await listPersonEnrollments(ctx, tenantId, leadId);
    const key = (row: { programId: string; opportunityId: string; enrolledAt: number }) =>
      `${row.programId}:${row.opportunityId}:${row.enrolledAt}`;
    const want = derived.map(key).sort().join(",");
    const have = stored.map(key).sort().join(",");
    if (want !== have) fail("I9", `person ${leadId} enrollments [${have}] but payments derive [${want}]`);
    if ((lead.status === "converted") !== stored.length > 0) {
      fail("I9", `person ${leadId} is ${lead.status} with ${stored.length} enrollments`);
    }
  }

  // I14, I16: decisions.
  const decisions: Doc<"resultAutomationDecisions">[] = [];
  for (const state of DECISION_STATES) {
    const rows = await bounded(ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_state_and_createdAt", (q) => q.eq("tenantId", tenantId).eq("state", state))
      .take(ROW_LIST_LIMIT + 1), ROW_LIST_LIMIT, `${state} decisions`);
    decisions.push(...rows.filter((decision) =>
      (decision.opportunityId && dealIds.has(decision.opportunityId)) ||
      (decision.providerPaymentId && paymentIds.has(decision.providerPaymentId))));
  }
  const readyByPayment = new Map<string, number>();
  for (const decision of decisions) {
    const sameKey = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_inputKey", (q) => q.eq("tenantId", tenantId).eq("inputKey", decision.inputKey))
      .take(2);
    if (sameKey.length > 1) fail("I14", `decision ${decision._id} shares its input key`);
    if (decision.state === "ready" && decision.providerPaymentId) {
      readyByPayment.set(decision.providerPaymentId, (readyByPayment.get(decision.providerPaymentId) ?? 0) + 1);
    }
    if ((decision.state === "ready" || decision.state === "needs_person") && decision.opportunityId) {
      const deal = await ctx.db.get("opportunities", decision.opportunityId);
      if (deal && decision.humanResultRevision !== (deal.humanResultRevision ?? 0)) {
        fail("I14", `${decision.state} decision ${decision._id} has revision ${decision.humanResultRevision}, deal ${deal._id} has ${deal.humanResultRevision ?? 0}`);
      }
    }
    const paymentDecision = decision.kind === "payment_win" || decision.kind === "additional_payment";
    if (paymentDecision && decision.state === "applied") {
      const row = decision.appliedPaymentRecordId && await ctx.db.get("paymentRecords", decision.appliedPaymentRecordId);
      if (!row || !decision.providerPaymentId || row.providerPaymentId !== decision.providerPaymentId) {
        fail("I14", `applied decision ${decision._id} names row ${decision.appliedPaymentRecordId ?? "none"}, which doesn't cite ${decision.providerPaymentId ?? "a payment"}`);
      }
    }
    // Call receipts use prompt and model versions checked by automation invariant A12.
    if (paymentDecision) {
      for (const [path, text] of freeText(decision)) fail("I16", `decision ${decision._id}${path} holds "${text}"`);
    }
  }
  for (const [paymentId, count] of readyByPayment) {
    if (count > 1) fail("I14", `provider payment ${paymentId} has ${count} ready decisions`);
  }

  // I16: pinned lines and the new events.
  const users = await bounded(ctx.db.query("users").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(SCOPE_LIMIT + 1), SCOPE_LIMIT, "users");
  for (const user of users) {
    const lines = await bounded(ctx.db.query("closerPinnedLines")
      .withIndex("by_tenantId_and_userId_and_dismissedAt_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("userId", user._id))
      .take(ROW_LIST_LIMIT + 1), ROW_LIST_LIMIT, "pinned lines for one user");
    for (const line of lines) {
      if (!dealIds.has(line.opportunityId)) continue;
      for (const [path, text] of freeText(line)) fail("I16", `pinned line ${line._id}${path} holds "${text}"`);
    }
  }
  for (const eventType of NEW_EVENT_TYPES) {
    const events = await bounded(ctx.db.query("domainEvents")
      .withIndex("by_tenantId_and_eventType_and_occurredAt", (q) => q.eq("tenantId", tenantId).eq("eventType", eventType))
      .take(ROW_LIST_LIMIT + 1), ROW_LIST_LIMIT, `${eventType} events`);
    for (const event of events) {
      const fields = {
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        reason: event.reason,
        metadata: event.metadata ? JSON.parse(event.metadata) as unknown : undefined,
      };
      for (const [path, text] of freeText(fields)) fail("I16", `event ${event._id}${path} holds "${text}"`);
    }
  }

  return { violations, attendance };
}

/** Reads every row in scope inside t.run and throws one error listing each broken invariant with ids. */
export async function assertPaymentInvariants(
  t: TestConvex<typeof schema>,
  scope: InvariantScope,
  options: { skip?: InvariantId[] } = {},
): Promise<void> {
  const seen = attendanceSeen.get(t) ?? new Map<string, Attendance>();
  const { violations, attendance } = await t.run(async (ctx) => await collect(ctx, scope, seen));
  // The next call compares against what this one saw, skipped or not.
  for (const [meetingId, mark] of attendance) {
    if (mark.status === "scheduled") seen.delete(meetingId);
    else seen.set(meetingId, mark);
  }
  attendanceSeen.set(t, seen);
  const skip = new Set<InvariantId>(options.skip ?? []);
  const broken = violations.filter((violation) => !skip.has(violation.id));
  if (broken.length > 0) {
    throw new Error(`Payment invariants broken:\n${broken.map(({ id, detail }) => `${id}: ${detail}`).join("\n")}`);
  }
}

/**
 * A deal won by a confirmed Whop payment, written the way the apply core will
 * write it: a provider row through the payment aggregate, the move to won
 * with the first payment's time, the active allocation, the sold program, the
 * person's enrollments and attendance owed on the scheduled meetings. Returns
 * the row.
 */
export async function seedProviderWin(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    providerPaymentId: Id<"providerPayments">;
    programId: Id<"tenantPrograms">;
    closerId: Id<"users">;
    approverId: Id<"users">;
    recordedAt: number;
  },
): Promise<Id<"paymentRecords">> {
  const payment = (await ctx.db.get("providerPayments", args.providerPaymentId))!;
  const deal = (await ctx.db.get("opportunities", args.opportunityId))!;
  const paymentRecordId = await seedProviderRow(ctx, {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    closerId: args.closerId,
    programId: args.programId,
    amountMinor: payment.totalMinor ?? 0,
    currency: payment.currency,
    recordedAt: args.recordedAt,
    recorder: args.approverId,
    providerPaymentId: payment._id,
  });
  await transitionOpportunity(ctx, args.opportunityId, {
    to: { stage: "closed", outcome: "won" },
    fields: { paymentReceivedAt: args.recordedAt },
    source: "admin",
    actorUserId: args.approverId,
  });
  await setActiveAllocation(ctx, {
    payment,
    record: (await ctx.db.get("paymentRecords", paymentRecordId))!,
    expectedAllocationRevision: payment.allocationRevision,
    reviewState: "recorded",
    matchMethod: "person",
    actorUserId: args.approverId,
    now: args.recordedAt,
  });
  await refreshSoldProgramCachesForOpportunity(ctx, { tenantId: args.tenantId, opportunityId: args.opportunityId });
  await syncPersonEnrollments(ctx, {
    tenantId: args.tenantId, leadId: deal.leadId, now: args.recordedAt, source: "admin", actorUserId: args.approverId,
  });
  await markAttendanceOwed(ctx, args.opportunityId);
  return paymentRecordId;
}

/**
 * The undo of a Whop win from Booked, in the order the exclusion core will
 * write it: the row disputed through its aggregate, the allocation cleared
 * (with the veto for a wrong match), the sold program refreshed, the deal back
 * at Booked with no first-payment time, attendance no longer owed, and the
 * person's enrollments re-derived.
 */
export async function seedUndoToBooked(
  ctx: MutationCtx,
  args: {
    paymentRecordId: Id<"paymentRecords">;
    approverId: Id<"users">;
    veto: boolean;
    now: number;
  },
): Promise<void> {
  const before = (await ctx.db.get("paymentRecords", args.paymentRecordId))!;
  const opportunityId = before.opportunityId!;
  await ctx.db.patch("paymentRecords", before._id, { status: "disputed", statusChangedAt: args.now });
  await replacePaymentAggregate(ctx, before, before._id);
  await clearActiveAllocation(ctx, (await ctx.db.get("paymentRecords", before._id))!,
    args.veto ? { vetoOpportunityId: opportunityId } : {});
  await refreshSoldProgramCachesForOpportunity(ctx, { tenantId: before.tenantId, opportunityId });
  const deal = await transitionOpportunity(ctx, opportunityId, {
    to: { stage: "booked" },
    fields: { paymentReceivedAt: undefined, updatedAt: args.now },
    source: "admin",
    actorUserId: args.approverId,
    exception: "provider_win_undone_to_booked",
    metadata: { exception: "provider_win_undone_to_booked" },
  });
  await clearAttendanceOwed(ctx, opportunityId);
  await syncPersonEnrollments(ctx, {
    tenantId: before.tenantId, leadId: deal.leadId, now: args.now, source: "admin", actorUserId: args.approverId,
  });
}
