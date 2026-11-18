import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { followMergeChain } from "../leads/identityResolution";
import { isPlaceholderEmail, normalizeEmail, normalizePhone } from "../lib/normalization";
import { isSideDeal } from "../lib/sideDeals";
import { isWonDeal } from "../opportunities/dealGuards";
import { systemLossReasonOf } from "../opportunities/stages";

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
const MAX_PAYMENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// https://docs.whop.com/api-reference/payments/retrieve-payment
const BILLING_REASONS = new Set([
  "subscription_create", "subscription_cycle", "subscription_update",
  "one_time", "manual", "subscription",
]);
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

async function bindingByExternalId<K extends Binding["kind"]>(
  ctx: ReadCtx,
  payment: Pick<Payment, "tenantId" | "connectionId">,
  kind: K,
  externalId?: string,
): Promise<Extract<Binding, { kind: K }> | null | "ambiguous"> {
  if (!externalId) return null;
  // Mapping changes append a version and disable the previous one. Only the
  // newest version can apply; an enabled predecessor indicates a conflict.
  const rows = await ctx.db.query("paymentProviderBindings")
    .withIndex("by_tenantId_and_connectionId_and_kind_and_externalId", (q) =>
      q.eq("tenantId", payment.tenantId).eq("connectionId", payment.connectionId)
        .eq("kind", kind).eq("externalId", externalId)).order("desc").take(2);
  const [current, previous] = rows;
  if ((current && current.binding.kind !== kind) || previous?.enabled) return "ambiguous";
  if (!current?.enabled) return null;
  return current.binding as Extract<Binding, { kind: K }>;
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
    return { deal, lead: survivor, binding, expectedProgramId: anchor.programId };
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
  const orderedKeys = payment.billingReason === "subscription_cycle"
    ? [membership, checkout]
    : [checkout, membership];
  for (const [kind, externalId] of orderedKeys) {
    const binding = await bindingByExternalId(ctx, payment, kind, externalId);
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
  const people = new Map([[person._id, person]]);
  let cursor = 0;
  for (const lead of people.values()) {
    // Add to the map as we walk, so nested merge history is visited as well.
    if (++cursor > IDENTITY_LIMIT) return null;
    add(lead.email);
    const [identifiers, merges] = await Promise.all([
      ctx.db.query("leadIdentifiers").withIndex("by_leadId", (q) =>
        q.eq("leadId", lead._id)).take(IDENTITY_LIMIT + 1),
      ctx.db.query("leadMergeHistory").withIndex("by_targetLeadId", (q) =>
        q.eq("targetLeadId", lead._id)).take(IDENTITY_LIMIT + 1),
    ]);
    if (identifiers.length > IDENTITY_LIMIT || merges.length > IDENTITY_LIMIT) return null;
    for (const identifier of identifiers) {
      if (identifier.tenantId !== person.tenantId) return null;
      if (identifier.type === "email" && identifier.confidence !== "suggested") add(identifier.value);
    }
    if (emails.size > IDENTITY_LIMIT) return null;
    for (const merge of merges) {
      if (merge.tenantId !== person.tenantId || people.has(merge.sourceLeadId)) continue;
      const source = await ctx.db.get("leads", merge.sourceLeadId);
      if (source?.tenantId !== person.tenantId || source.status !== "merged") return null;
      if (people.size >= IDENTITY_LIMIT) return null;
      people.set(source._id, source);
    }
  }
  return { emails, leadIds: [...people.keys()] };
}

async function hasUnboundMembership(ctx: ReadCtx, payment: Payment, person: Doc<"leads">) {
  const identity = await personEmails(ctx, person, payment.payerEmail);
  if (!identity) return "capacity_hold";

  const { tenantId } = payment;
  const payments = new Map<Id<"providerPayments">, Payment>();
  for (const leadId of identity.leadIds) {
    const [resolved, candidates] = await Promise.all([
      ctx.db.query("providerPayments").withIndex("by_tenantId_and_leadId_and_paidAt", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", leadId)).take(PAYMENT_SCAN_LIMIT + 1),
      ctx.db.query("providerPayments").withIndex("by_tenantId_and_candidateLeadId_and_paidAt", (q) =>
        q.eq("tenantId", tenantId).eq("candidateLeadId", leadId)).take(PAYMENT_SCAN_LIMIT + 1),
    ]);
    if (resolved.length > PAYMENT_SCAN_LIMIT || candidates.length > PAYMENT_SCAN_LIMIT) return "unbound_membership";
    for (const row of [...resolved, ...candidates]) payments.set(row._id, row);
    if (payments.size > PAYMENT_SCAN_LIMIT) return "unbound_membership";
  }
  for (const email of identity.emails) {
    const rows = await ctx.db.query("providerPayments").withIndex("by_tenantId_and_payerEmail_and_paidAt", (q) =>
      q.eq("tenantId", tenantId).eq("payerEmail", email)).take(PAYMENT_SCAN_LIMIT + 1);
    if (rows.length > PAYMENT_SCAN_LIMIT) return "unbound_membership";
    for (const row of rows) payments.set(row._id, row);
    if (payments.size > PAYMENT_SCAN_LIMIT) return "unbound_membership";
  }

  const checked = new Set<string>();
  for (const row of payments.values()) {
    if (row._id === payment._id || row.status !== "paid" || !row.membershipId || row.totalMinor === 0) continue;
    const key = `${row.connectionId}:${row.membershipId}`;
    if (checked.has(key)) continue;
    checked.add(key);
    const binding = await bindingByExternalId(ctx, row, "membership_deal", row.membershipId);
    if (!binding || binding === "ambiguous") return "unbound_membership";
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
  bound?: BoundTarget,
): Promise<ReviewReason | null> {
  if (payment.paidAt !== undefined && deal.createdAt > payment.paidAt) return "deal_newer_than_payment";
  if (payment.paidAt === undefined || payment.paidAt < autoImportAfter ||
      Date.now() - payment.paidAt > MAX_PAYMENT_AGE_MS) return "stale_payment";
  if (payment.lineItemCount !== 1) return "multi_item";

  const [product, variant] = await Promise.all([
    bindingByExternalId(ctx, payment, "product_program", payment.productId),
    bindingByExternalId(ctx, payment, "variant_type", payment.variantId),
  ]);
  if (!product || product === "ambiguous" || !variant || variant === "ambiguous") return "unmapped_product";
  const program = await ctx.db.get("tenantPrograms", product.programId);
  if (program?.tenantId !== payment.tenantId) return "unmapped_product";

  if (bound?.expectedProgramId && bound.expectedProgramId !== program._id) return "unmapped_product";
  if ((payment.financingInstallmentsCount ?? 0) > 1 ||
      FINANCING_METHODS.has(payment.paymentMethodType ?? "")) return "financing";
  if (payment.billingReason === "subscription_cycle" && bound?.binding.kind !== "membership_deal") return "renewal_unbound";
  if (!BILLING_REASONS.has(payment.billingReason ?? "")) return "unknown_billing_reason";

  const membershipHold = await hasUnboundMembership(ctx, payment, person);
  if (membershipHold) return membershipHold;
  if (payment.totalMinor === undefined) return "unsupported_currency";

  const records = await ctx.db.query("paymentRecords").withIndex("by_opportunityId_and_recordedAt", (q) =>
    q.eq("opportunityId", deal._id)).take(PAYMENT_SCAN_LIMIT + 1);
  if (records.some((row) => row.tenantId === payment.tenantId &&
      row.status !== "disputed" && row.providerPaymentId === undefined)) {
    return "unlinked_manual_payment";
  }
  if (records.length > PAYMENT_SCAN_LIMIT) return "capacity_hold";
  if (!deal.assignedCloserId) return "no_closer";
  if (payment.adverseState.startsWith("dispute_")) return "dispute";
  if (payment.adverseState !== "none" || payment.refundedMinor > 0) return "refund";
  // Until the refresh describes the adverse delivery, review the pending signal.
  if (payment.adverseFencedAt !== undefined) return "dispute";
  return null;
}

function closedDealReason(deals: Deal[]): ReviewReason {
  if (deals.length > DEAL_SCAN_LIMIT) return "capacity_hold";
  if (deals.some(isWonDeal)) return "won_deal_no_membership";
  if (deals.some((deal) => deal.outcome === "lost" && !systemLossReasonOf(deal))) return "lost_by_person";
  if (deals.some(systemLossReasonOf)) return "system_loss";
  return "no_open_deal";
}

/** Reads the CRM target and any reason a reviewer must decide. */
export async function findPaymentTarget(ctx: ReadCtx, payment: Payment): Promise<PaymentTarget> {
  if (payment.paymentRecordId) return {
    kind: "resolved",
    paymentRecordId: payment.paymentRecordId,
    leadId: payment.leadId,
    opportunityId: payment.opportunityId,
    matchMethod: payment.matchMethod,
  };

  const connection = await ctx.db.get("tenantPaymentConnections", payment.connectionId);
  if (connection?.tenantId !== payment.tenantId) return needsPerson("ambiguous_person");
  const bound = await findBoundTarget(ctx, payment);
  if (bound === "ambiguous") return needsPerson("capacity_hold");
  if (bound) {
    const { deal, lead, binding } = bound;
    if (deal.outcome === "lost" && !systemLossReasonOf(deal)) return needsPerson("lost_by_person", lead._id, [deal]);
    if (deal.stage === "qualified") return needsPerson("qualified_only", lead._id, [deal]);
    if (deal.outcome === "open" && isSideDeal(deal)) return needsPerson("side_deal", lead._id, [deal]);
    if (isWonDeal(deal) && binding.kind !== "membership_deal") {
      return needsPerson("won_deal_no_membership", lead._id, [deal]);
    }
    const hold = await dealPaymentHold(ctx, payment, lead, deal, connection.autoImportAfter, bound);
    if (hold) return needsPerson(hold, lead._id, [deal]);
    return {
      kind: "ready", leadId: lead._id, opportunityId: deal._id,
      matchMethod: binding.kind === "membership_deal" ? "membership_binding" : "checkout_binding",
    };
  }

  const { tenantId } = payment;
  const email = usableEmail(payment.payerEmail);
  const phone = payment.payerPhone?.trim().startsWith("+") ? normalizePhone(payment.payerPhone) : undefined;
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
  if (deals.length > 1) return needsPerson("several_open_deals", person._id, deals);
  const [deal] = deals;
  if (!deal) {
    const closed = await personDeals(ctx, tenantId, person._id);
    return needsPerson(closedDealReason(closed), person._id, closed);
  }
  if (deal.stage === "qualified") return needsPerson("qualified_only", person._id, deals);
  if (isSideDeal(deal) || deal.stage === "call_held") return needsPerson("side_deal", person._id, deals);
  if (deal.stage !== "booked" && deal.stage !== "follow_up") return needsPerson("no_open_deal", person._id, deals);

  const hold = await dealPaymentHold(ctx, payment, person, deal, connection.autoImportAfter);
  if (hold) return needsPerson(hold, person._id, deals);
  return { kind: "ready", leadId: person._id, opportunityId: deal._id, matchMethod: "email_one_open_deal" };
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
