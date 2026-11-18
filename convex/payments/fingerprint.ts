import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { paymentCounts, readDealPayments } from "../lib/enrollments";
import { sha256Hex, stableJson } from "../lib/stableHash";

// The state a payment preview depends on, so the approval that follows can
// tell whether anything it showed has changed (build contract §2.1). It never
// pins `updatedAt`, `latestActivityAt` or `refreshGeneration`: system writes
// and refresh requests move those without changing what the person approved.

export const FINGERPRINT_MEETING_LIMIT = 50;
export const FINGERPRINT_TASK_LIMIT = 20;
export const FINGERPRINT_BINDING_LIMIT = 20;
const FINGERPRINT_VERSION = 1;

type Ctx = QueryCtx | MutationCtx;

function overflow(what: string, opportunityId: Id<"opportunities">, limit: number) {
  return new Error(`Deal ${opportunityId} has more than ${limit} ${what}; a preview can't pin part of them`);
}

/** sha256 of the state a preview depends on. Never updatedAt, latestActivityAt or refreshGeneration. */
export async function paymentStateFingerprint(
  ctx: Ctx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    paymentRecordId?: Id<"paymentRecords">;
    providerPaymentId?: Id<"providerPayments">;
    /** Tasks a receipt names (an undo's or a restore's), pinned even when no longer pending. */
    receiptTaskIds?: readonly Id<"followUps">[];
    extra?: readonly (string | number | boolean | null)[];
  },
): Promise<string> {
  const { tenantId, opportunityId } = args;
  const deal = await ctx.db.get("opportunities", opportunityId);
  if (!deal || deal.tenantId !== tenantId) throw new Error(`Deal ${opportunityId} not found in this tenant`);

  const record = args.paymentRecordId ? await ctx.db.get("paymentRecords", args.paymentRecordId) : null;
  if (record && record.tenantId !== tenantId) throw new Error(`Payment ${record._id} is in another tenant`);
  const payment = args.providerPaymentId ? await ctx.db.get("providerPayments", args.providerPaymentId) : null;
  if (payment && payment.tenantId !== tenantId) throw new Error(`Provider payment ${payment._id} is in another tenant`);

  const dealPayments = await readDealPayments(ctx, opportunityId);
  const countingPayments = dealPayments
    .filter((row) => row.tenantId === tenantId && paymentCounts(row))
    .map((row) => [row._id, row.status] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  const meetings = await ctx.db.query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
    .take(FINGERPRINT_MEETING_LIMIT + 1);
  if (meetings.length > FINGERPRINT_MEETING_LIMIT) throw overflow("meetings", opportunityId, FINGERPRINT_MEETING_LIMIT);

  const pending = await ctx.db.query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q.eq("opportunityId", opportunityId).eq("status", "pending"))
    .take(FINGERPRINT_TASK_LIMIT + 1);
  if (pending.length > FINGERPRINT_TASK_LIMIT) throw overflow("pending tasks", opportunityId, FINGERPRINT_TASK_LIMIT);
  const receiptTaskIds = [...new Set(args.receiptTaskIds ?? [])];
  if (receiptTaskIds.length > FINGERPRINT_TASK_LIMIT) throw overflow("receipt tasks", opportunityId, FINGERPRINT_TASK_LIMIT);
  const tasks = new Map<Id<"followUps">, Doc<"followUps"> | null>(pending.map((task) => [task._id, task]));
  for (const taskId of receiptTaskIds) {
    if (tasks.has(taskId)) continue;
    const task = await ctx.db.get("followUps", taskId);
    tasks.set(taskId, task?.tenantId === tenantId ? task : null);
  }

  const bindings = await ctx.db.query("paymentProviderBindings")
    .withIndex("by_tenantId_and_opportunityId_and_kind", (q) =>
      q.eq("tenantId", tenantId).eq("opportunityId", opportunityId).eq("kind", "membership_deal"))
    .take(FINGERPRINT_BINDING_LIMIT + 1);
  if (bindings.length > FINGERPRINT_BINDING_LIMIT) throw overflow("membership bindings", opportunityId, FINGERPRINT_BINDING_LIMIT);

  const byId = <T extends readonly [string, ...unknown[]]>(rows: T[]) =>
    rows.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  const pinned = {
    version: FINGERPRINT_VERSION,
    row: record && [
      record._id, record.status, record.amountMinor, record.currency, record.programId,
      record.paymentType, record.recordedAt, record.providerPaymentId ?? null,
    ],
    payment: payment && [
      payment._id, payment.paymentRecordId ?? null, payment.allocationRevision, payment.reviewState,
      payment.adverseState, payment.adverseFencedAt !== undefined, payment.refundedMinor,
      payment.sourceUpdatedAt, payment.notMySaleAt !== undefined,
    ],
    deal: [
      deal.stage, deal.outcome, deal.lostReason ?? null, deal.lostByUserId ?? null, deal.lostAt ?? null,
      deal.paymentReceivedAt ?? null, deal.assignedCloserId ?? null, deal.leadId, deal.humanResultRevision ?? 0,
    ],
    countingPayments,
    meetings: byId(meetings.map((meeting) => [meeting._id, meeting.status, meeting.heldMarkedAt ?? null] as const)),
    tasks: byId([...tasks].map(([taskId, task]) =>
      [taskId, task?.status ?? null, task?.reminderScheduledAt ?? null] as const)),
    bindings: byId(bindings.flatMap((binding) => binding.enabled ? [[binding._id, binding.version] as const] : [])),
    extra: args.extra ?? [],
  };
  return await sha256Hex(stableJson(pinned));
}
