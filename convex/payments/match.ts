import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { followMergeChain } from "../leads/identityResolution";
import { mergedLeadIds } from "../lib/mergedLeads";
import { isPlaceholderEmail, isPlaceholderPhone, normalizeEmail, normalizePhone } from "../lib/normalization";
import { isSideDeal } from "../lib/sideDeals";
import { awaitsCallResult, isOpenDeal, isQualifiedDeal, isSideDealAtCallHeld, isWonDeal } from "../opportunities/dealGuards";
import { dealStageOf, systemLossReasonOf } from "../opportunities/stages";
import { findEnabledBinding } from "./bindingLookup";
import { checkPaymentCapacity, otherDealCashHold, PAYMENT_ROWS_PER_DEAL_HOLD } from "./capacity";
import { MAX_PROVIDER_PAYMENT_AGE_MS } from "./reviewTiming";

type ReadCtx = QueryCtx | MutationCtx;
type Payment = Doc<"providerPayments">;
type Deal = Doc<"opportunities">;
type Binding = Doc<"paymentProviderBindings">["binding"];
type DealBinding = Extract<Binding, { kind: "checkout_deal" | "membership_deal" }>;
type ReviewReason = Exclude<NonNullable<Payment["reviewReason"]>, "ready">;
type BoundTarget = {
  deal: Deal;
  lead: Doc<"leads">;
  binding: DealBinding;
  expectedProgramId?: Id<"tenantPrograms">;
  anchor?: Doc<"paymentRecords">;
};

export type PaymentTarget =
  | {
      kind: "resolved";
      paymentRecordId: Id<"paymentRecords">;
      leadId?: Id<"leads">;
      opportunityId?: Id<"opportunities">;
      matchMethod?: Payment["matchMethod"];
    }
  | {
      kind: "ready";
      leadId: Id<"leads">;
      opportunityId: Id<"opportunities">;
      matchMethod: NonNullable<Payment["matchMethod"]>;
    }
  | {
      kind: "needs_person";
      reason: ReviewReason;
      candidateLeadId?: Id<"leads">;
      candidateOpportunityIds: Id<"opportunities">[];
    };

const IDENTITY_LIMIT = 16;
export const PROVIDER_CANDIDATE_DEAL_LIMIT = 20;
const DEAL_SCAN_LIMIT = 100;
const PAYMENT_SCAN_LIMIT = 40;

// https://docs.whop.com/api-reference/payments/retrieve-payment
const INITIAL_BILLING_REASONS = new Set(["subscription_create", "one_time", "manual"]);
const KNOWN_RENEWAL_REASONS = new Set(["subscription_cycle", "subscription_update"]);

function couldBeRenewal(reason?: string) {
  // Unknown and legacy reasons cannot establish a first charge by email.
  return !INITIAL_BILLING_REASONS.has(reason ?? "");
}
const FINANCING_METHODS = new Set([
  "addi", "affirm", "afterpay", "afterpay_clearpay", "alma", "billie",
  "capchase_pay", "card_installments_three", "card_installments_six",
  "card_installments_twelve", "claritypay", "clearpay", "flex_pay",
  "klarna", "kriya", "kueski", "mondu", "oney", "oney_3x", "oney_4x",
  "paypal_pay_later", "scalapay", "sequra", "sezzle", "splitit", "sunbit",
  "tabby", "tamara", "zip",
]);

function usableEmail(email?: string) {
  const normalized = email && normalizeEmail(email);
  return normalized && !isPlaceholderEmail(normalized) ? normalized : undefined;
}

async function identifierPeople(
  ctx: ReadCtx,
  tenantId: Id<"tenants">,
  type: "email" | "phone",
  value: string | undefined,
): Promise<Map<Id<"leads">, Doc<"leads">> | null> {
  const people = new Map<Id<"leads">, Doc<"leads">>();
  if (!value) return people;

  // Use the CRM's normalized phone identifiers. The profile phone has no index.
  const [canonical, identifiers] = await Promise.all([
    type === "email"
      ? ctx.db.query("leads").withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", tenantId).eq("email", value)).take(IDENTITY_LIMIT + 1)
      : [],
    ctx.db.query("leadIdentifiers").withIndex("by_tenantId_and_type_and_value", (q) =>
      q.eq("tenantId", tenantId).eq("type", type).eq("value", value)).take(IDENTITY_LIMIT + 1),
  ]);
  if (canonical.length > IDENTITY_LIMIT || identifiers.length > IDENTITY_LIMIT) return null;

  const leads = new Map(canonical.map((lead) => [lead._id, lead]));
  for (const identifier of identifiers) {
    if (identifier.confidence === "suggested" || leads.has(identifier.leadId)) continue;
    const lead = await ctx.db.get("leads", identifier.leadId);
    if (!lead || lead.tenantId !== tenantId) return null;
    leads.set(lead._id, lead);
  }
  for (const lead of leads.values()) {
    const person = await followMergeChain(ctx, lead);
    if (!person) return null;
    people.set(person._id, person);
  }
  return people;
}

function sortCandidateDeals(deals: Deal[]) {
  return deals.sort((a, b) =>
    (b.latestMeetingAt ?? -Infinity) - (a.latestMeetingAt ?? -Infinity) ||
    b.createdAt - a.createdAt ||
    a._id.localeCompare(b._id),
  );
}

function needsPerson(
  reason: ReviewReason,
  leadId?: Id<"leads">,
  deals: Deal[] = [],
): PaymentTarget {
  return {
    kind: "needs_person",
    reason,
    candidateLeadId: leadId,
    candidateOpportunityIds: sortCandidateDeals(deals)
      .slice(0, PROVIDER_CANDIDATE_DEAL_LIMIT)
      .map((deal) => deal._id),
  };
}

function personDeals(ctx: ReadCtx, tenantId: Id<"tenants">, leadId: Id<"leads">) {
  return ctx.db.query("opportunities").withIndex("by_tenantId_and_leadId", (q) =>
    q.eq("tenantId", tenantId).eq("leadId", leadId)).take(DEAL_SCAN_LIMIT + 1);
}

async function openDeals(ctx: ReadCtx, tenantId: Id<"tenants">, leadId: Id<"leads">) {
  return await ctx.db.query("opportunities").withIndex("by_tenantId_and_leadId_and_outcome", (q) =>
    q.eq("tenantId", tenantId).eq("leadId", leadId).eq("outcome", "open")).take(DEAL_SCAN_LIMIT + 1);
}

async function membershipAnchor(
  ctx: ReadCtx,
  payment: Pick<Payment, "tenantId" | "connectionId" | "membershipId">,
  binding: Extract<DealBinding, { kind: "membership_deal" }>,
) {
  const anchor = await ctx.db.get("paymentRecords", binding.anchorPaymentRecordId);
  if (anchor?.tenantId !== payment.tenantId || anchor.status === "disputed" ||
      anchor.opportunityId !== binding.opportunityId) return null;
  if (anchor.providerPaymentId) {
    const origin = await ctx.db.get("providerPayments", anchor.providerPaymentId);
    if (origin?.tenantId !== payment.tenantId || origin.connectionId !== payment.connectionId ||
        origin.membershipId !== payment.membershipId || origin.paymentRecordId !== anchor._id) return null;
  }
  return anchor;
}

async function dealForBinding(
  ctx: ReadCtx,
  payment: Pick<Payment, "tenantId" | "connectionId" | "membershipId">,
  binding: DealBinding,
): Promise<BoundTarget | null> {
  const deal = await ctx.db.get("opportunities", binding.opportunityId);
  const [boundLead, currentLead] = await Promise.all([
    ctx.db.get("leads", binding.leadId),
    deal && ctx.db.get("leads", deal.leadId),
  ]);
  if (deal?.tenantId !== payment.tenantId || boundLead?.tenantId !== payment.tenantId ||
      currentLead?.tenantId !== payment.tenantId) return null;
  // Binding ids are historical. A merge may leave the original person id in
  // the binding, but a deal moved to an unrelated person must invalidate it.
  const survivor = await followMergeChain(ctx, boundLead);
  if (!survivor || currentLead._id !== survivor._id) return null;
  if (binding.kind === "membership_deal") {
    const anchor = await membershipAnchor(ctx, payment, binding);
    if (!anchor) return null;
    return { deal, lead: survivor, binding, anchor, expectedProgramId: deal.soldProgramId ?? anchor.programId };
  }
  return {
    deal,
    lead: survivor,
    binding,
    expectedProgramId: deal.soldProgramId ?? deal.firstBookingProgramId,
  };
}

async function findBoundTarget(ctx: ReadCtx, payment: Payment) {
  // Checkout IDs can remain on later charges. The membership controls a
  // renewal even when that checkout still has a binding of its own.
  const checkout = ["checkout_deal", payment.checkoutConfigurationId] as const;
  const membership = ["membership_deal", payment.membershipId] as const;
  const orderedKeys = couldBeRenewal(payment.billingReason)
    ? [membership, checkout]
    : [checkout, membership];
  for (const [kind, externalId] of orderedKeys) {
    const binding = await findEnabledBinding(ctx, payment, kind, externalId);
    if (binding === "ambiguous") return binding;
    const target = binding && await dealForBinding(ctx, payment, binding);
    if (target) return target;
  }
  return null;
}

/**
 * Include the person's other addresses so a pending intake or a payment seen
 * before a merge cannot hide an earlier membership.
 */
async function personEmails(
  ctx: ReadCtx,
  person: Doc<"leads">,
  payerEmail: string | undefined,
) {
  const emails = new Set<string>();
  const add = (email: string | undefined) => {
    const usable = usableEmail(email);
    if (usable) emails.add(usable);
  };
  add(payerEmail);
  const leadIds = await mergedLeadIds(ctx, person.tenantId, person._id);
  // This matcher must hold before the shared merge walk can truncate.
  if (leadIds.length > IDENTITY_LIMIT) return null;
  for (const leadId of leadIds) {
    const lead = leadId === person._id ? person : await ctx.db.get("leads", leadId);
    if (lead?.tenantId !== person.tenantId ||
        (leadId !== person._id && lead.status !== "merged")) return null;
    add(lead.email);
    const identifiers = await ctx.db.query("leadIdentifiers").withIndex("by_leadId", (q) =>
      q.eq("leadId", leadId)).take(IDENTITY_LIMIT + 1);
    if (identifiers.length > IDENTITY_LIMIT) return null;
    for (const identifier of identifiers) {
      if (identifier.tenantId !== person.tenantId) return null;
      if (identifier.type === "email" && identifier.confidence !== "suggested") add(identifier.value);
    }
    if (emails.size > IDENTITY_LIMIT) return null;
  }
  return { emails, leadIds };
}

async function hasUnboundMembership(ctx: ReadCtx, payment: Payment, person: Doc<"leads">) {
  const identity = await personEmails(ctx, person, payment.payerEmail);
  if (!identity) return "read_limit";

  const { connectionId } = payment;
  const payments = new Map<Id<"providerPayments">, Payment>();
  for (const leadId of identity.leadIds) {
    const [resolved, candidates] = await Promise.all([
      ctx.db.query("providerPayments").withIndex("by_connectionId_and_leadId_and_paidAt", (q) =>
        q.eq("connectionId", connectionId).eq("leadId", leadId)).take(PAYMENT_SCAN_LIMIT + 1),
      ctx.db.query("providerPayments").withIndex("by_connectionId_and_candidateLeadId_and_paidAt", (q) =>
        q.eq("connectionId", connectionId).eq("candidateLeadId", leadId)).take(PAYMENT_SCAN_LIMIT + 1),
    ]);
    if (resolved.length > PAYMENT_SCAN_LIMIT || candidates.length > PAYMENT_SCAN_LIMIT) return "read_limit";
    for (const row of [...resolved, ...candidates]) payments.set(row._id, row);
    if (payments.size > PAYMENT_SCAN_LIMIT) return "read_limit";
  }
  for (const email of identity.emails) {
    const rows = await ctx.db.query("providerPayments").withIndex("by_connectionId_and_payerEmail_and_paidAt", (q) =>
      q.eq("connectionId", connectionId).eq("payerEmail", email)).take(PAYMENT_SCAN_LIMIT + 1);
    if (rows.length > PAYMENT_SCAN_LIMIT) return "read_limit";
    for (const row of rows) payments.set(row._id, row);
    if (payments.size > PAYMENT_SCAN_LIMIT) return "read_limit";
  }

  const checked = new Set<string>();
  for (const row of payments.values()) {
    if (row.tenantId !== payment.tenantId || row._id === payment._id || row.status !== "paid" || !row.membershipId || row.totalMinor === 0) continue;
    const key = row.membershipId;
    if (checked.has(key)) continue;
    checked.add(key);
    const binding = await findEnabledBinding(ctx, row, "membership_deal", row.membershipId);
    if (binding === "ambiguous") return "binding_conflict";
    if (!binding) return "unbound_membership";
    if ((await dealForBinding(ctx, row, binding))?.lead._id !== person._id) return "unbound_membership";
  }
  return null;
}

async function dealPaymentHold(
  ctx: ReadCtx,
  payment: Payment,
  person: Doc<"leads">,
  deal: Deal,
  autoImportAfter: number,
  now: number,
  bound?: BoundTarget,
): Promise<ReviewReason | null> {
  if (payment.paidAt !== undefined && deal.createdAt > payment.paidAt) return "deal_newer_than_payment";
  if (payment.paidAt === undefined || payment.paidAt < autoImportAfter ||
      now - payment.paidAt > MAX_PROVIDER_PAYMENT_AGE_MS) return "stale_payment";
  if (payment.lineItemCount !== 1) return "multi_item";
  if (payment.adverseState.startsWith("dispute_")) return "dispute";
  if (payment.adverseState !== "none" || payment.refundedMinor > 0) return "refund";
  if (payment.adverseFencedAt !== undefined) return "dispute";

  const renewal = couldBeRenewal(payment.billingReason);
  if (renewal && !bound?.anchor) {
    return KNOWN_RENEWAL_REASONS.has(payment.billingReason ?? "") ? "renewal_unbound" : "unknown_billing_reason";
  }
  if (renewal && bound?.anchor) {
    // A confirmed renewal inherits the sold program even after mappings are removed.
    const program = bound.expectedProgramId && await ctx.db.get("tenantPrograms", bound.expectedProgramId);
    if (program?.tenantId !== payment.tenantId || program._id !== bound.anchor.programId) return "program_mismatch";
  } else {
    const [product, variant] = await Promise.all([
      findEnabledBinding(ctx, payment, "product_program", payment.productId),
      findEnabledBinding(ctx, payment, "variant_type", payment.variantId),
    ]);
    if (product === "ambiguous" || variant === "ambiguous") return "binding_conflict";
    if (!product || !variant) return "unmapped_product";
    const program = await ctx.db.get("tenantPrograms", product.programId);
    if (program?.tenantId !== payment.tenantId) return "unmapped_product";
    if (bound?.expectedProgramId && bound.expectedProgramId !== program._id) return "program_mismatch";
  }
  if ((payment.financingInstallmentsCount ?? 0) > 1 ||
      FINANCING_METHODS.has(payment.paymentMethodType ?? "")) return "financing";

  if (!bound) {
    const membershipHold = await hasUnboundMembership(ctx, payment, person);
    if (membershipHold) return membershipHold;
  }
  if (payment.totalMinor === undefined) return "unsupported_currency";

  // The hold every writer applies (capacity.ts): 40 stored rows on the deal, or 100 deals for the person.
  if (!(await checkPaymentCapacity(ctx, { opportunityId: deal._id, leadId: deal.leadId })).ok) return "capacity_hold";
  const records = await ctx.db.query("paymentRecords").withIndex("by_opportunityId_and_recordedAt", (q) =>
    q.eq("opportunityId", deal._id)).take(PAYMENT_ROWS_PER_DEAL_HOLD);
  if (records.some((row) => row.tenantId === payment.tenantId && row._id !== bound?.anchor?._id &&
      row.status !== "disputed" && row.providerPaymentId === undefined)) {
    return "unlinked_manual_payment";
  }
  if (!deal.assignedCloserId) return "no_closer";
  return null;
}

/** A deal a person took this payment off as a wrong match: never proposed again (contract §1.2). */
function isVetoed(payment: Pick<Payment, "excludedOpportunityIds">, deal: Pick<Deal, "_id">) {
  return payment.excludedOpportunityIds?.includes(deal._id) ?? false;
}

function openDealHold(deal: Deal): ReviewReason | null {
  if (isQualifiedDeal(deal)) return "qualified_only";
  if (isSideDealAtCallHeld(deal) || (isOpenDeal(deal) && isSideDeal(deal)) ||
      (awaitsCallResult(deal) && dealStageOf(deal).stage === "call_held")) return "side_deal";
  // Plan §2.3 makes provider money an exception to canTakePayment for a
  // Follow-up deal with a pending reschedule link. The Phase 2 win expires it.
  return null;
}

function closedDealReason(deals: Deal[]): ReviewReason {
  if (deals.length > DEAL_SCAN_LIMIT) return "read_limit";
  if (deals.some(isWonDeal)) return "won_deal_no_membership";
  if (deals.some((deal) => deal.outcome === "lost" && !systemLossReasonOf(deal))) return "lost_by_person";
  if (deals.some(systemLossReasonOf)) return "system_loss";
  return "no_open_deal";
}

/** Reads the CRM target and any reason a reviewer must decide. */
export async function findPaymentTarget(
  ctx: ReadCtx, payment: Payment, now = Date.now(),
): Promise<PaymentTarget> {
  if (payment.reviewState === "historical") return needsPerson("historical");
  if (payment.reviewState === "dismissed") return needsPerson("dismissed");
  if (payment.paymentRecordId) return {
    kind: "resolved",
    paymentRecordId: payment.paymentRecordId,
    leadId: payment.leadId,
    opportunityId: payment.opportunityId,
    matchMethod: payment.matchMethod,
  };

  if (payment.status !== "paid" || payment.totalMinor === 0) return needsPerson("not_paid");
  const connection = await ctx.db.get("tenantPaymentConnections", payment.connectionId);
  if (connection?.tenantId !== payment.tenantId) return needsPerson("connection_mismatch");
  const bound = await findBoundTarget(ctx, payment);
  if (bound === "ambiguous") return needsPerson("binding_conflict");
  if (bound) {
    const { deal, lead, binding } = bound;
    if (isVetoed(payment, deal)) return needsPerson("excluded_wrong_match", lead._id);
    if (deal.outcome === "lost" && !systemLossReasonOf(deal)) return needsPerson("lost_by_person", lead._id, [deal]);
    const positionHold = openDealHold(deal);
    if (positionHold) return needsPerson(positionHold, lead._id, [deal]);
    if (isWonDeal(deal) && binding.kind !== "membership_deal") {
      return needsPerson("won_deal_no_membership", lead._id, [deal]);
    }
    const hold = await dealPaymentHold(ctx, payment, lead, deal, connection.autoImportAfter, now, bound);
    if (hold) return needsPerson(hold, lead._id, [deal]);
    return {
      kind: "ready", leadId: lead._id, opportunityId: deal._id,
      matchMethod: binding.kind === "membership_deal" ? "membership_binding" : "checkout_binding",
    };
  }

  const { tenantId } = payment;
  const email = usableEmail(payment.payerEmail);
  const rawPhone = payment.payerPhone?.trim();
  const phone = rawPhone?.startsWith("+") && !isPlaceholderPhone(rawPhone)
    ? normalizePhone(rawPhone) : undefined;
  const emailPeople = await identifierPeople(ctx, tenantId, "email", email);
  if (!emailPeople || emailPeople.size > 1) return needsPerson("ambiguous_person");
  const [person] = emailPeople.values();
  const phonePeople = await identifierPeople(ctx, tenantId, "phone", phone);
  if (!phonePeople) return needsPerson("ambiguous_person");

  if (!person) {
    if (phonePeople.size > 1) return needsPerson("ambiguous_person");
    const [phonePerson] = phonePeople.values();
    if (phonePerson) return needsPerson("phone_only", phonePerson._id, await personDeals(ctx, tenantId, phonePerson._id));
    return needsPerson(email ? "unknown_payer" : "no_payer_email");
  }
  if ([...phonePeople.keys()].some((leadId) => leadId !== person._id)) {
    return needsPerson("phone_conflict", person._id, await personDeals(ctx, tenantId, person._id));
  }

  const deals = await openDeals(ctx, tenantId, person._id);
  // Every open deal counts, a vetoed one included; a vetoed deal is never a candidate.
  if (deals.length > 1) {
    return needsPerson("several_open_deals", person._id, deals.filter((deal) => !isVetoed(payment, deal)));
  }
  const [deal] = deals;
  if (deal && isVetoed(payment, deal)) return needsPerson("excluded_wrong_match", person._id);
  if (!deal) {
    const closed = await personDeals(ctx, tenantId, person._id);
    return needsPerson(closedDealReason(closed), person._id, closed.filter((closedDeal) => !isVetoed(payment, closedDeal)));
  }
  const positionHold = openDealHold(deal);
  if (positionHold) return needsPerson(positionHold, person._id, deals);

  const hold = await dealPaymentHold(ctx, payment, person, deal, connection.autoImportAfter, now)
    ?? await otherDealCashHold(ctx, payment, deal);
  if (hold) return needsPerson(hold, person._id, deals);
  return { kind: "ready", leadId: person._id, opportunityId: deal._id, matchMethod: "email_one_open_deal" };
}

export function baseProviderReviewState(
  payment: Pick<Payment, "status" | "totalMinor" | "paidAt">,
  autoImportAfter: number,
): "not_actionable" | "historical" | "needs_person" {
  if (payment.status !== "paid" || payment.totalMinor === 0) return "not_actionable";
  if (payment.paidAt !== undefined && payment.paidAt < autoImportAfter) return "historical";
  return "needs_person";
}

/** Intake calls this after storing a fresh read. Repeated classifications keep their timestamp. */
export async function refreshProviderPaymentReview(
  ctx: MutationCtx,
  providerPaymentId: Id<"providerPayments">,
): Promise<void> {
  const payment = await ctx.db.get("providerPayments", providerPaymentId);
  if (!payment || payment.paymentRecordId ||
      (payment.reviewState !== "needs_person" && payment.reviewState !== "not_actionable")) return;

  // A paid payment in a currency whose amount could not be stored still goes to
  // a person (`unsupported_currency`); only a known zero is nobody's work.
  const payable = payment.status === "paid" && (payment.totalMinor === undefined || payment.totalMinor > 0);
  const target = payable ? await findPaymentTarget(ctx, payment) : null;
  if (target?.kind === "resolved") return;

  const reviewState = target ? "needs_person" : "not_actionable";
  const reviewReason = target?.kind === "ready" ? "ready" : target?.reason;
  const candidateLeadId = target?.kind === "ready" ? target.leadId : target?.candidateLeadId;
  const candidateOpportunityId = target?.kind === "ready" ? target.opportunityId : undefined;
  const hasExpectedTimestamp = target ? payment.matchedAt !== undefined : payment.matchedAt === undefined;
  if (payment.reviewState === reviewState && payment.reviewReason === reviewReason &&
      payment.candidateLeadId === candidateLeadId && payment.candidateOpportunityId === candidateOpportunityId &&
      hasExpectedTimestamp) return;

  await ctx.db.patch("providerPayments", providerPaymentId, {
    reviewState,
    reviewReason,
    candidateLeadId,
    candidateOpportunityId,
    matchedAt: target ? Date.now() : undefined,
  });
}
