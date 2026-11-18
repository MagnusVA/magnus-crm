import type { Doc, Id } from "../_generated/dataModel";
import type { PaymentType } from "../lib/paymentTypes";
import { RESERVED_LOSS_REASONS, type DealPosition, type SystemLossReason } from "../opportunities/stages";
import { DEALS_PER_PERSON_HOLD, PAYMENT_ROWS_PER_DEAL_HOLD } from "../payments/capacity";
import type { PaymentTarget } from "../payments/match";
import { MAX_PROVIDER_PAYMENT_AGE_MS } from "../payments/reviewTiming";
import type { AutomationMode, PaymentProposal } from "./proposals";
import { paymentVetoTuple, type PaymentDecisionKind } from "./receipts";

export const PAYMENT_RULE_VERSION = "payment-rule@1";
type Decision = Doc<"resultAutomationDecisions">;
type Gate = Decision["gates"][number];
type Proposal = PaymentProposal;
type TupleValue = string | number | boolean | null;

export type PaymentDecisionInput = {
  now: number;
  settings: { mode: AutomationMode; policyVersion: number; activationVersion: number };
  payment: Pick<Doc<"providerPayments">, "_id" | "status" | "totalMinor" | "currency" | "paidAt" | "adverseState"
    | "billingReason" | "lineItemCount" | "productId" | "variantId" | "allocationRevision" | "sourceUpdatedAt"
    | "reviewState" | "notMySaleAt"> & {
      refundedMinor?: number;
      fenced: boolean;
      fenceRevision?: number;
      financing: boolean;
      excludedOpportunityIds: Id<"opportunities">[];
    };
  autoImportAfter: number;
  connectionEpoch?: number;
  target: PaymentTarget;
  deal: null | {
    _id: Id<"opportunities">;
    position: DealPosition;
    isSideDeal: boolean;
    systemLoss: SystemLossReason | null;
    /** Lost through an automatic call refusal (`call_refusal`, no person). Only a person's Billing pick wins it. */
    callRefusal?: boolean;
    createdAt: number;
    assignedCloserId?: Id<"users">;
    humanResultRevision: number;
    storedPaymentCount: number;
    personDealCount: number;
    firstCountingCreditCloserId?: Id<"users">;
    blockingManualPaymentIds: Id<"paymentRecords">[];
    currentMeeting?: { _id: Id<"meetings">; scheduledAt: number };
    pendingTasks: { _id: Id<"followUps">; type: string; reason: string; closerId: Id<"users"> }[];
  };
  mapping: {
    programId?: Id<"tenantPrograms">;
    paymentType?: PaymentType;
    bindingIds: Id<"paymentProviderBindings">[];
    bindingVersions: number[];
  };
  membership: null | { bindingId: Id<"paymentProviderBindings">; version: number; anchorCounts: boolean };
  standDown: boolean;
  factGates?: Gate[];
};

export type DerivedDecision = null | {
  kind: PaymentDecisionKind;
  wouldWrite: boolean;
  gates: Gate[];
  proposal?: Proposal;
  confirmRoute?: Decision["confirmRoute"];
  noticeUserId?: Id<"users">;
  meetingId?: Id<"meetings">;
  inputTuple: readonly TupleValue[];
  vetoTuple: readonly string[];
};

/** A held matcher result can name a unique candidate without authorizing a write. */
export function paymentDecisionTarget(target: PaymentTarget) {
  if (target.kind === "ready") return { leadId: target.leadId, opportunityId: target.opportunityId };
  if (target.kind === "needs_person" && target.candidateOpportunityIds.length === 1) {
    return { leadId: target.candidateLeadId, opportunityId: target.candidateOpportunityIds[0] };
  }
  return null;
}

/** A deal an automatic call refusal closed: lost with `call_refusal` and no person on the loss. */
export function isAutomaticCallRefusal(deal: Pick<Doc<"opportunities">, "outcome" | "lostReason" | "lostByUserId">): boolean {
  return deal.outcome === "lost" && deal.lostReason === RESERVED_LOSS_REASONS.call_refusal && deal.lostByUserId === undefined;
}

export function paymentBillingReason(reason: string | undefined) {
  switch (reason) {
    case "subscription_create":
    case "one_time":
    case "manual":
      return "initial";
    case "subscription_cycle":
    case "subscription_update":
      return "renewal";
    default:
      return "unknown";
  }
}

export function deriveDecision(input: PaymentDecisionInput): DerivedDecision {
  const { deal, target, payment, settings, mapping, membership, now, autoImportAfter, standDown } = input;
  const candidate = paymentDecisionTarget(target);
  if (settings.mode === "off" || payment.status !== "paid" || payment.totalMinor === 0 ||
      !deal || !candidate?.leadId || candidate.opportunityId !== deal._id) return null;

  const kind = deal.position === "won" ? "additional_payment" : "payment_win";
  const { assignedCloserId, currentMeeting } = deal;
  const tasks = [...deal.pendingTasks].sort((a, b) => a._id.localeCompare(b._id));
  const reminder = deal.position === "follow_up" && assignedCloserId
    ? tasks.find((task) => task.type === "manual_reminder" && task.reason !== "stale_opportunity_nudge" && task.closerId === assignedCloserId)
    : undefined;
  const meeting = deal.position === "booked" && assignedCloserId && currentMeeting && now >= currentMeeting.scheduledAt
    ? currentMeeting : undefined;
  const confirmRoute = meeting ? "meeting" : reminder ? "reminder" : "billing";
  const noticeUserId = confirmRoute === "billing" ? undefined : assignedCloserId;

  const gates = new Set<Gate>(input.factGates);
  if (target.kind === "needs_person") gates.add(target.reason);
  if (payment.reviewState === "historical") gates.add("historical");
  if (payment.reviewState === "dismissed") gates.add("dismissed");
  const billingReason = paymentBillingReason(payment.billingReason);
  const validMembership = membership?.anchorCounts === true;
  const bound = target.kind === "ready" &&
    (target.matchMethod === "checkout_binding" || (target.matchMethod === "membership_binding" && validMembership));

  if (deal.position === "qualified") gates.add("qualified_only");
  if (kind === "payment_win" && (deal.isSideDeal || deal.position === "call_held")) gates.add("side_deal");
  if (deal.position === "lost") {
    if (deal.callRefusal) gates.add("call_refusal_loss");
    else if (!deal.systemLoss) gates.add("lost_by_person");
    else if (!bound && target.kind === "ready") gates.add("system_loss");
  }
  if (kind === "additional_payment" && !validMembership) gates.add("won_deal_no_membership");
  if (payment.paidAt === undefined || now - payment.paidAt >= MAX_PROVIDER_PAYMENT_AGE_MS) gates.add("stale_payment");
  if (payment.paidAt !== undefined) {
    if (payment.paidAt <= autoImportAfter) gates.add("historical");
    if (deal.createdAt > payment.paidAt) gates.add("deal_newer_than_payment");
  }
  if (payment.lineItemCount !== 1) gates.add("multi_item");
  if (!mapping.programId || !mapping.paymentType) gates.add("unmapped_product");
  if (payment.financing) gates.add("financing");
  if (billingReason === "unknown") gates.add("unknown_billing_reason");
  if (billingReason === "renewal" && !validMembership) gates.add("renewal_unbound");
  if (payment.totalMinor === undefined || !Number.isSafeInteger(payment.totalMinor) ||
      payment.totalMinor < 0 || !/^[A-Z]{3}$/.test(payment.currency)) gates.add("unsupported_currency");
  if (deal.blockingManualPaymentIds.length) gates.add("unlinked_manual_payment");
  if (!assignedCloserId) gates.add("no_closer");
  if (deal.firstCountingCreditCloserId && deal.firstCountingCreditCloserId !== assignedCloserId) gates.add("credit_conflict");
  if (tasks.some((task) => task.closerId !== assignedCloserId)) gates.add("task_closer_conflict");
  if (deal.storedPaymentCount >= PAYMENT_ROWS_PER_DEAL_HOLD || deal.personDealCount >= DEALS_PER_PERSON_HOLD) {
    gates.add("capacity_hold");
  }
  if (payment.adverseState.startsWith("dispute_") || payment.fenced) gates.add("dispute");
  if ((payment.adverseState !== "none" && !payment.adverseState.startsWith("dispute_")) || (payment.refundedMinor ?? 0) > 0) gates.add("refund");
  if (payment.notMySaleAt !== undefined) gates.add("not_my_sale");
  if (payment.excludedOpportunityIds.includes(deal._id)) gates.add("excluded_wrong_match");
  if (standDown) gates.add("stood_down");

  const gateList = [...gates].sort();
  const wouldWrite = target.kind === "ready" && gateList.length === 0;
  const proposal = wouldWrite && assignedCloserId && mapping.programId && mapping.paymentType && payment.totalMinor !== undefined
    ? {
      amountMinor: payment.totalMinor,
      currency: payment.currency,
      paymentType: mapping.paymentType,
      programId: mapping.programId,
      attributedCloserId: assignedCloserId,
      ...(reminder && { completesFollowUpId: reminder._id }),
      expiresFollowUpIds: kind === "payment_win" ? tasks.flatMap((task) => task === reminder ? [] : [task._id]) : [],
    }
    : undefined;

  // Each variable-length part has a length prefix. Time enters only through
  // the route and time gates, so the same state hashes the same on every wake.
  const blockers = [...deal.blockingManualPaymentIds].sort();
  const exclusions = [...payment.excludedOpportunityIds].sort();
  const bindings = mapping.bindingIds.map((id, i) => [id, mapping.bindingVersions[i] ?? null] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const inputTuple = [
    PAYMENT_RULE_VERSION, kind, settings.mode, settings.policyVersion, settings.activationVersion,
    payment._id, payment.status, payment.totalMinor ?? null, payment.currency, payment.paidAt ?? null,
    payment.adverseState, payment.refundedMinor ?? 0, payment.fenced, payment.fenceRevision ?? 0, billingReason, payment.financing,
    payment.lineItemCount, payment.productId ?? null, payment.variantId ?? null,
    payment.allocationRevision, payment.sourceUpdatedAt, payment.reviewState, payment.notMySaleAt !== undefined,
    autoImportAfter, input.connectionEpoch ?? null, target.kind, target.kind === "ready" ? target.matchMethod : null,
    candidate.leadId, deal._id, deal.position, deal.isSideDeal, deal.systemLoss, deal.createdAt,
    assignedCloserId ?? null, deal.humanResultRevision, deal.storedPaymentCount, deal.personDealCount,
    deal.firstCountingCreditCloserId ?? null, currentMeeting?._id ?? null, currentMeeting?.scheduledAt ?? null,
    mapping.programId ?? null, mapping.paymentType ?? null,
    membership?.bindingId ?? null, membership?.version ?? null, membership?.anchorCounts ?? false,
    confirmRoute, noticeUserId ?? null, meeting?._id ?? null, reminder?._id ?? null,
    blockers.length, ...blockers,
    exclusions.length, ...exclusions,
    tasks.length, ...tasks.flatMap((task) => [task._id, task.type, task.reason, task.closerId]),
    bindings.length, ...bindings.flat(),
    gateList.length, ...gateList,
  ];
  return {
    kind, wouldWrite, gates: gateList, proposal, confirmRoute, noticeUserId, meetingId: meeting?._id, inputTuple,
    vetoTuple: paymentVetoTuple(payment._id, deal._id),
  };
}
