import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { sha256Hex, stableJson } from "../lib/stableHash";

// The apply receipt (build contract §2.7): the decision row that says a person
// confirmed a Whop payment into a CRM payment, with what the confirmation
// changed. Undo, restore and grading read it. When a person picked a deal no
// ready decision named, the receipt is inserted here, so undo works the same.

/** `ruleVersion` of a receipt no rule proposed: a person picked the deal. */
export const PERSON_PICK_RULE_VERSION = "person_pick";
/** Receipts one provider payment can hold before a lookup stops trusting its read. */
export const APPLIED_RECEIPT_LIMIT = 20;

type Decision = Doc<"resultAutomationDecisions">;
export type PaymentDecisionKind = Extract<Decision["kind"], "payment_win" | "additional_payment">;

/**
 * The veto subject of a payment decision: the same for a first win and a later
 * payment, so a stand-down on one holds for the other.
 */
export function paymentVetoTuple(
  providerPaymentId: Id<"providerPayments">,
  opportunityId: Id<"opportunities">,
): readonly string[] {
  return ["payment", providerPaymentId, opportunityId];
}

export async function paymentVetoKey(
  providerPaymentId: Id<"providerPayments">,
  opportunityId: Id<"opportunities">,
): Promise<string> {
  return await sha256Hex(stableJson(paymentVetoTuple(providerPaymentId, opportunityId)));
}

/**
 * Marks the decision `applied` (or inserts an `applied` ask decision when none
 * existed) and returns its id. Call after the payment row and the active
 * allocation are written, in the same mutation. A retry that finds this
 * receipt already applied to the same row returns it unchanged.
 */
export async function recordApplyReceipt(
  ctx: MutationCtx,
  args: {
    decisionId?: Id<"resultAutomationDecisions">;
    tenantId: Id<"tenants">;
    kind: PaymentDecisionKind;
    providerPaymentId: Id<"providerPayments">;
    opportunityId: Id<"opportunities">;
    paymentRecordId: Id<"paymentRecords">;
    appliedVia: NonNullable<Decision["appliedVia"]>;
    approverUserId: Id<"users">;
    before?: Decision["before"];
    now: number;
  },
): Promise<Id<"resultAutomationDecisions">> {
  const { tenantId, providerPaymentId, opportunityId, paymentRecordId } = args;
  const [record, payment, deal] = await Promise.all([
    ctx.db.get("paymentRecords", paymentRecordId),
    ctx.db.get("providerPayments", providerPaymentId),
    ctx.db.get("opportunities", opportunityId),
  ]);
  if (!deal || deal.tenantId !== tenantId) throw new Error(`Deal ${opportunityId} not found in this tenant`);
  if (!record || record.tenantId !== tenantId || record.opportunityId !== opportunityId ||
      record.providerPaymentId !== providerPaymentId) {
    throw new Error(`Payment ${paymentRecordId} isn't this provider payment's row on deal ${opportunityId}`);
  }
  if (!payment || payment.tenantId !== tenantId || payment.paymentRecordId !== paymentRecordId) {
    throw new Error(`Provider payment ${providerPaymentId} doesn't count through payment ${paymentRecordId}`);
  }

  if (args.decisionId) {
    const decision = await ctx.db.get("resultAutomationDecisions", args.decisionId);
    if (!decision || decision.tenantId !== tenantId || decision.providerPaymentId !== providerPaymentId ||
        decision.opportunityId !== opportunityId || decision.kind !== args.kind) {
      throw new Error(`Decision ${args.decisionId} is not this payment's ${args.kind} on deal ${opportunityId}`);
    }
    if (decision.state === "applied") {
      if (decision.appliedPaymentRecordId === paymentRecordId) return decision._id;
      throw new Error(`Decision ${decision._id} was applied to another payment`);
    }
    if (decision.state !== "ready") throw new Error(`Decision ${decision._id} is ${decision.state}, not ready`);
    await ctx.db.patch("resultAutomationDecisions", decision._id, {
      state: "applied",
      resolvedAt: args.now,
      resolvedByUserId: args.approverUserId,
      appliedPaymentRecordId: paymentRecordId,
      appliedVia: args.appliedVia,
      before: args.before,
    });
    return decision._id;
  }

  const applied = await ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_providerPaymentId_and_state", (q) =>
      q.eq("tenantId", tenantId).eq("providerPaymentId", providerPaymentId).eq("state", "applied"))
    .take(APPLIED_RECEIPT_LIMIT + 1);
  if (applied.length > APPLIED_RECEIPT_LIMIT) {
    throw new Error(`Provider payment ${providerPaymentId} has more than ${APPLIED_RECEIPT_LIMIT} applied receipts`);
  }
  const existing = applied.find((decision) => decision.appliedPaymentRecordId === paymentRecordId);
  if (existing) {
    if (existing.opportunityId !== opportunityId || existing.kind !== args.kind) {
      throw new Error(`Decision ${existing._id} applied this payment as something else`);
    }
    return existing._id;
  }

  const tenant = await ctx.db.get("tenants", tenantId);
  const settings = tenant?.resultAutomation;
  return await ctx.db.insert("resultAutomationDecisions", {
    tenantId,
    kind: args.kind,
    mode: "ask",
    state: "applied",
    inputKey: await sha256Hex(stableJson([
      PERSON_PICK_RULE_VERSION, args.kind, providerPaymentId, opportunityId, paymentRecordId,
    ])),
    vetoKey: await paymentVetoKey(providerPaymentId, opportunityId),
    ruleVersion: PERSON_PICK_RULE_VERSION,
    policyVersion: settings?.kinds[args.kind].policyVersion ?? 0,
    activationVersion: settings?.activationVersion ?? 0,
    humanResultRevision: deal.humanResultRevision ?? 0,
    wouldWrite: false,
    gates: [],
    providerPaymentId,
    leadId: deal.leadId,
    opportunityId,
    meetingId: record.meetingId,
    assignedCloserId: deal.assignedCloserId,
    evidence: {
      allocationRevision: payment.allocationRevision,
      sourceUpdatedAt: payment.sourceUpdatedAt,
      bindingIds: [],
      bindingVersions: [],
    },
    createdAt: args.now,
    resolvedAt: args.now,
    resolvedByUserId: args.approverUserId,
    appliedPaymentRecordId: paymentRecordId,
    appliedVia: args.appliedVia,
    before: args.before,
  });
}
