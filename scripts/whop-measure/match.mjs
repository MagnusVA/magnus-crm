import { groupBy, IDENTITY_LIMIT, matchIdentity } from "./crm.mjs";
import { DAY, usableEmail } from "./normalize.mjs";

const DEAL_LIMIT = 100;
const PAYMENT_LIMIT = 40;
const SYSTEM_LOSSES = new Set(["no_show", "canceled", "stale"]);

function isSystemLoss(deal) {
  return deal.outcome === "lost" && deal.lostByUserId === undefined && SYSTEM_LOSSES.has(deal.lostReason);
}

function bindingFor(crm, kind, externalId) {
  if (!externalId) return undefined;
  const [current, previous] = crm.bindings.get(`${kind}:${externalId}`) ?? [];
  if (previous?.enabled || (current && current.binding?.kind !== kind)) return "ambiguous";
  return current?.enabled ? current.binding : undefined;
}

function membershipAnchor(crm, binding, membershipId) {
  const anchor = crm.records.get(binding.anchorPaymentRecordId);
  if (!anchor || anchor.status === "disputed" || anchor.opportunityId !== binding.opportunityId) return undefined;
  if (anchor.providerPaymentId) {
    const origin = crm.providerById.get(anchor.providerPaymentId);
    if (origin?.membershipId !== membershipId || origin?.paymentRecordId !== anchor._id) return undefined;
  }
  return anchor;
}

function boundDeal(crm, kind, externalId) {
  const binding = bindingFor(crm, kind, externalId);
  if (!binding || binding === "ambiguous") return binding;
  const deal = crm.deals.get(binding.opportunityId);
  const person = crm.survivor(binding.leadId);
  if (!person || deal?.leadId !== person) return undefined;
  const anchor = kind === "membership_deal" ? membershipAnchor(crm, binding, externalId) : undefined;
  if (kind === "membership_deal" && !anchor) return undefined;
  const program = anchor
    ? anchor.programId
    : deal.soldProgramId ?? deal.firstBookingProgramId;
  return { deal, person, kind, program };
}

function trustedTarget(crm, payment) {
  const checkout = ["checkout_deal", payment.checkoutId];
  const membership = ["membership_deal", payment.membershipId];
  const bindings = payment.billingReason === "subscription_cycle"
    ? [membership, checkout] : [checkout, membership];
  for (const [kind, id] of bindings) {
    const target = boundDeal(crm, kind, id);
    if (target) return target;
  }
  return undefined;
}

function resolvedTarget(crm, payment) {
  const stored = crm.providerByExternal.get(payment.id) ?? [];
  if (stored.length > 1) return "ambiguous";
  const [origin] = stored;
  if (!origin?.paymentRecordId) return undefined;
  const record = crm.records.get(origin.paymentRecordId);
  if (!record || record.status === "disputed") return "ambiguous";
  const deal = crm.deals.get(origin.opportunityId ?? record.opportunityId);
  const person = crm.survivor(origin.leadId ?? deal?.leadId);
  return { record, deal, person };
}

function aliasEmails(crm, person, payerEmail) {
  const leads = crm.leadAliases.get(person) ?? [];
  if (leads.length > IDENTITY_LIMIT) return undefined;
  const emails = new Set();
  if (payerEmail) emails.add(payerEmail);
  for (const lead of leads) {
    const identifiers = crm.identifiersByLead.get(lead._id) ?? [];
    if (identifiers.length > IDENTITY_LIMIT) return undefined;
    const leadEmail = usableEmail(lead.email);
    if (leadEmail) emails.add(leadEmail);
    for (const identifier of identifiers) {
      if (identifier.type !== "email" || identifier.confidence === "suggested") continue;
      const email = usableEmail(identifier.value);
      if (email) emails.add(email);
    }
  }
  return emails.size > IDENTITY_LIMIT ? undefined : emails;
}

export function buildMembershipIndex(crm, observed, identities) {
  const rows = new Map(crm.providerPayments.map((row) => [row.externalPaymentId, {
    id: row.externalPaymentId,
    status: row.status,
    membershipId: row.membershipId,
    zero: row.totalMinor === 0,
    email: usableEmail(row.payerEmail),
    people: [crm.survivor(row.leadId), crm.survivor(row.candidateLeadId)].filter(Boolean),
  }]));
  for (const payment of observed) {
    const identity = identities.get(payment.id);
    const person = identity?.exactEmail ?? (identity?.bucket === "phoneOnly" ? identity.people[0] : undefined);
    const people = rows.get(payment.id)?.people ?? [];
    rows.set(payment.id, {
      id: payment.id,
      status: payment.status,
      membershipId: payment.membershipId,
      zero: payment.total?.decimals === 2 && payment.total.minor === 0n,
      email: payment.email,
      people: [...new Set(person ? [...people, person] : people)],
    });
  }
  const payments = [...rows.values()];
  return {
    email: groupBy(payments, (row) => row.email),
    person: groupBy(payments.flatMap((row) => row.people.map((person) => ({ person, row }))),
      (entry) => entry.person),
  };
}

export function membershipAmbiguity(crm, index, payment, person) {
  const emails = aliasEmails(crm, person, payment.email);
  if (!emails) return "capacity_hold";
  const prior = new Set((index.person.get(person) ?? []).map((entry) => entry.row));
  for (const email of emails) {
    for (const row of index.email.get(email) ?? []) prior.add(row);
  }
  if (prior.size > PAYMENT_LIMIT) return "unbound_membership";
  const membershipIds = new Set();
  for (const row of prior) {
    if (row.id === payment.id || row.status !== "paid" || !row.membershipId || row.zero) continue;
    membershipIds.add(row.membershipId);
  }
  for (const membershipId of membershipIds) {
    if (boundDeal(crm, "membership_deal", membershipId)?.person !== person) return "unbound_membership";
  }
  return undefined;
}

function dealHold(crm, payment, person, deal, membershipIndex, asOf, bound) {
  if (deal.createdAt > payment.paidAt) return "deal_newer_than_payment";
  const cutoff = crm.connection?.autoImportAfter;
  if (payment.paidAt === undefined || payment.paidAt < cutoff || asOf - payment.paidAt > 7 * DAY) {
    return "stale_payment";
  }
  if (payment.lineItemCount !== 1) return "multi_item";
  if (!crm.hasProviderContext || !Number.isFinite(cutoff)) return "missing_provider_context";
  const product = bindingFor(crm, "product_program", payment.productId);
  const variant = bindingFor(crm, "variant_type", payment.variantId);
  if (!product || product === "ambiguous" || !variant || variant === "ambiguous" ||
    !crm.programs.has(product.programId) || (bound?.program && bound.program !== product.programId)) {
    return "unmapped_product";
  }
  if (payment.financing) return "financing";
  if (payment.billingReason === "subscription_cycle" && bound?.kind !== "membership_deal") return "renewal_unbound";
  if (!payment.billingReason) return "unknown_billing_reason";
  const membershipHold = membershipAmbiguity(crm, membershipIndex, payment, person);
  if (membershipHold) return membershipHold;
  if (payment.total?.decimals !== 2 ||
    payment.total.minor < 0n || payment.total.minor > BigInt(Number.MAX_SAFE_INTEGER)) return "unsupported_currency";
  const records = crm.recordsByDeal.get(deal._id) ?? [];
  if (records.some((row) => row.status !== "disputed" && row.providerPaymentId === undefined)) {
    return "unlinked_manual_payment";
  }
  if (records.length >= PAYMENT_LIMIT) return "capacity_hold";
  if (!deal.assignedCloserId) return "no_closer";
  const stored = crm.providerByExternal.get(payment.id)?.[0];
  if (payment.disputeHold || stored?.adverseFencedAt !== undefined) return "dispute";
  if (payment.refunded) return "refund";
  return undefined;
}

function held(reason, person, deals = [], targetDeal) {
  return { kind: "needs_person", reason, person, deals, targetDeal };
}

export function assessPayment(crm, payment, identity, membershipIndex, asOf) {
  const resolved = resolvedTarget(crm, payment);
  if (resolved === "ambiguous") return held("capacity_hold");
  if (resolved) {
    return { kind: "resolved", person: resolved.person, deals: resolved.deal ? [resolved.deal] : [],
      targetDeal: resolved.deal };
  }
  if (payment.total?.decimals === 2 && payment.total.minor <= 0n) {
    return { kind: "not_actionable", deals: [] };
  }
  const bound = trustedTarget(crm, payment);
  if (bound === "ambiguous") return held("capacity_hold");
  if (bound) {
    const { person, deal, kind } = bound;
    if (deal.outcome === "lost" && !isSystemLoss(deal)) {
      return held("lost_by_person", person, [deal], deal);
    }
    if (deal.stage === "qualified") return held("qualified_only", person, [deal], deal);
    if (deal.outcome === "open" && deal.source === "side_deal") return held("side_deal", person, [deal], deal);
    if (deal.outcome === "won" && kind !== "membership_deal") {
      return held("won_deal_no_membership", person, [deal], deal);
    }
    const hold = dealHold(crm, payment, person, deal, membershipIndex, asOf, bound);
    if (hold) return held(hold, person, [deal], deal);
    return { kind: "ready", person, deals: [deal], targetDeal: deal };
  }

  const person = identity.exactEmail;
  const deals = crm.currentDealsByPerson.get(person) ?? [];
  if (identity.bucket !== "email") {
    const candidate = person ?? (identity.bucket === "phoneOnly" ? identity.people[0] : undefined);
    return held(identity.reason, candidate, crm.currentDealsByPerson.get(candidate) ?? []);
  }
  const open = deals.filter((deal) => deal.outcome === "open");
  if (open.length > 1) return held("several_open_deals", person, open);
  if (open.length === 0) {
    if (deals.length > DEAL_LIMIT) return held("capacity_hold", person, deals);
    if (deals.some((deal) => deal.outcome === "won")) return held("won_deal_no_membership", person, deals);
    if (deals.some((deal) => deal.outcome === "lost" && !isSystemLoss(deal))) {
      return held("lost_by_person", person, deals);
    }
    if (deals.some(isSystemLoss)) return held("system_loss", person, deals);
    return held("no_open_deal", person, deals);
  }
  const [deal] = open;
  if (deal.stage === "qualified") return held("qualified_only", person, open);
  if (deal.source === "side_deal" || deal.stage === "call_held") return held("side_deal", person, open);
  if (deal.stage !== "booked" && deal.stage !== "follow_up") return held("no_open_deal", person, open);
  const hold = dealHold(crm, payment, person, deal, membershipIndex, asOf);
  if (hold) return held(hold, person, open);
  return { kind: "ready", person, deals: open, targetDeal: deal };
}

export function identifyPayments(crm, payments) {
  return new Map(payments.map((payment) => [payment.id, matchIdentity(crm, payment)]));
}
