import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { followMergeChain } from "../leads/identityResolution";
import { mergedLeadIds } from "../lib/mergedLeads";
import { isPlaceholderEmail, isPlaceholderPhone, normalizeEmail, normalizePhone } from "../lib/normalization";
import { findEnabledBinding } from "./bindingLookup";
/** A payment can stay pending for days before it settles and gets a fresh paid time. */
const CONTACTLESS_WINDOW_MS = 30 * 86_400_000;

type ReadCtx = QueryCtx | MutationCtx;
type Payment = Doc<"providerPayments">;
const PROVISIONAL_STATUSES = ["pending", "authorized", "unresolved"] as const;
const IDENTITY_LIMIT = 16;

function usableEmail(raw?: string) {
  const email = raw && normalizeEmail(raw);
  return email && !isPlaceholderEmail(email) ? email : undefined;
}

function usablePhone(raw?: string) {
  return raw && !isPlaceholderPhone(raw) ? normalizePhone(raw) : undefined;
}

export function isProvisionalPayment(payment: Payment) {
  return PROVISIONAL_STATUSES.some((status) => status === payment.status) &&
    payment.totalMinor !== 0 && !payment.paymentRecordId &&
    payment.reviewState !== "historical" && payment.reviewState !== "dismissed";
}

async function personContactKeys(ctx: ReadCtx, person: Doc<"leads">) {
  const { tenantId } = person;
  const leadIds = await mergedLeadIds(ctx, tenantId, person._id);
  if (leadIds.length > IDENTITY_LIMIT) return null;
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const leadId of leadIds) {
    const lead = leadId === person._id ? person : await ctx.db.get("leads", leadId);
    if (lead?.tenantId !== tenantId || (leadId !== person._id && lead.status !== "merged")) return null;
    const email = usableEmail(lead.email);
    const phone = usablePhone(lead.phone);
    if (email) emails.add(email);
    if (phone) phones.add(phone);
    const identifiers = await ctx.db.query("leadIdentifiers")
      .withIndex("by_leadId", (q) => q.eq("leadId", leadId)).take(IDENTITY_LIMIT + 1);
    if (identifiers.length > IDENTITY_LIMIT) return null;
    for (const identifier of identifiers) {
      if (identifier.tenantId !== tenantId) return null;
      if (identifier.confidence === "suggested" ||
          (identifier.type !== "email" && identifier.type !== "phone")) continue;
      const key = identifier.type === "email" ? usableEmail(identifier.value) : usablePhone(identifier.value);
      if (key) (identifier.type === "email" ? emails : phones).add(key);
    }
    if (emails.size + phones.size > IDENTITY_LIMIT) return null;
  }
  return { emails, phones, leadIds };
}

/** Finds provisional evidence that could belong to the person, even before the paid matcher runs. */
export async function possibleProvisionalPayment(
  ctx: ReadCtx, person: Doc<"leads">, now = Date.now(),
): Promise<Payment | "unknown" | null> {
  const keys = await personContactKeys(ctx, person);
  if (!keys) return "unknown";
  const tenantId = person.tenantId;
  let remaining = IDENTITY_LIMIT;
  // A payment with no contact details names nobody, so it could be anyone's.
  // Only one created in the last 30 days is still likely to settle, and one
  // whose details were purged is older than that. These rows get their own
  // budget, read newest first, so old history can neither use it up nor stop
  // every refusal in the tenant.
  async function readContactless(range: { order(o: "desc"): { take(limit: number): Promise<Payment[]> } }) {
    const since = now - CONTACTLESS_WINDOW_MS;
    const rows = await range.order("desc").take(IDENTITY_LIMIT + 1);
    const recent = rows.filter((payment) => payment.payerDetailsClearedAt === undefined &&
      payment.sourceCreatedAt >= since);
    // A row is stored no earlier than Whop created it. A full page whose
    // oldest row was stored inside the window may hide more recent ones.
    const pageMayHideRecent = rows.length > IDENTITY_LIMIT && rows[rows.length - 1]._creationTime >= since;
    if (recent.length > IDENTITY_LIMIT || pageMayHideRecent) return "unknown" as const;
    return firstLive(recent);
  }
  async function readRange(range: { take(limit: number): Promise<Payment[]> }) {
    const rows = await range.take(remaining + 1);
    if (rows.length > remaining) return "unknown" as const;
    remaining -= rows.length;
    return firstLive(rows);
  }
  async function firstLive(rows: Payment[]) {
    for (const payment of rows) {
      if (!isProvisionalPayment(payment)) continue;
      const connection = await ctx.db.get("tenantPaymentConnections", payment.connectionId);
      if (payment.tenantId !== tenantId || connection?.tenantId !== tenantId) return "unknown" as const;
      if (payment.sourceCreatedAt >= connection.autoImportAfter) return payment;
    }
    return null;
  }

  for (const status of PROVISIONAL_STATUSES) {
    const emailPayments = (email: string | undefined) => ctx.db.query("providerPayments")
      .withIndex("by_tenantId_and_status_and_payerEmail_and_payerPhone", (q) => {
        const range = q.eq("tenantId", tenantId).eq("status", status).eq("payerEmail", email);
        return email === undefined ? range.eq("payerPhone", undefined) : range;
      });
    const ranges = [
      ...Array.from(keys.emails, emailPayments),
      ...Array.from(keys.phones, (phone) => ctx.db.query("providerPayments")
        .withIndex("by_tenantId_and_status_and_payerPhone", (q) =>
          q.eq("tenantId", tenantId).eq("status", status).eq("payerPhone", phone))),
    ];
    for (const range of ranges) {
      const payment = await readRange(range);
      if (payment) return payment;
    }
    const contactless = await readContactless(emailPayments(undefined));
    if (contactless) return contactless;
  }

  // The checkout or membership can still name this person when someone else is paying.
  let bindingBudget = IDENTITY_LIMIT;
  for (const leadId of keys.leadIds) {
    const bindings = await ctx.db.query("paymentProviderBindings")
      .withIndex("by_tenantId_and_enabled_and_binding_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("enabled", true).eq("binding.leadId", leadId))
      .take(bindingBudget + 1);
    if (bindings.length > bindingBudget) return "unknown";
    bindingBudget -= bindings.length;
    for (const { binding, externalId, connectionId } of bindings) {
      if (binding.kind !== "checkout_deal" && binding.kind !== "membership_deal") continue;
      const deal = await ctx.db.get("opportunities", binding.opportunityId);
      if (deal?.tenantId !== tenantId || deal.leadId !== person._id) continue;
      for (const status of PROVISIONAL_STATUSES) {
        const payments = ctx.db.query("providerPayments");
        const range = binding.kind === "checkout_deal"
          ? payments.withIndex("by_connectionId_and_status_and_checkoutConfigurationId", (q) =>
            q.eq("connectionId", connectionId).eq("status", status).eq("checkoutConfigurationId", externalId))
          : payments.withIndex("by_connectionId_and_status_and_membershipId", (q) =>
            q.eq("connectionId", connectionId).eq("status", status).eq("membershipId", externalId));
        const payment = await readRange(range);
        if (payment) return payment;
      }
    }
  }
  return null;
}

async function contactPeople(ctx: ReadCtx, tenantId: Id<"tenants">, type: "email" | "phone", value: string) {
  const [canonical, identifiers] = await Promise.all([
    type === "email"
      ? ctx.db.query("leads").withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", tenantId).eq("email", value)).take(IDENTITY_LIMIT + 1)
      : [],
    ctx.db.query("leadIdentifiers").withIndex("by_tenantId_and_type_and_value", (q) =>
      q.eq("tenantId", tenantId).eq("type", type).eq("value", value)).take(IDENTITY_LIMIT + 1),
  ]);
  if (canonical.length > IDENTITY_LIMIT || identifiers.length > IDENTITY_LIMIT) return null;
  const ids = new Set(canonical.map(({ _id }) => _id));
  for (const identifier of identifiers) {
    if (identifier.confidence !== "suggested") ids.add(identifier.leadId);
  }
  const people = new Set<Id<"leads">>();
  for (const id of ids) {
    const lead = canonical.find((row) => row._id === id) ?? await ctx.db.get("leads", id);
    if (lead?.tenantId !== tenantId) return null;
    const person = await followMergeChain(ctx, lead);
    if (!person) return null;
    people.add(person._id);
  }
  return people;
}

/** A unique live email with no conflicting phone can stop a refusal before a payment settles. */
export async function matchedProvisionalLead(ctx: ReadCtx, payment: Payment): Promise<Id<"leads"> | undefined> {
  const email = usableEmail(payment.payerEmail);
  if (!isProvisionalPayment(payment) || !email) return;
  const phone = usablePhone(payment.payerPhone);
  const { tenantId } = payment;
  const [connection, emails, phones, checkout, membership] = await Promise.all([
    ctx.db.get("tenantPaymentConnections", payment.connectionId),
    contactPeople(ctx, tenantId, "email", email),
    phone ? contactPeople(ctx, tenantId, "phone", phone) : new Set<Id<"leads">>(),
    findEnabledBinding(ctx, payment, "checkout_deal", payment.checkoutConfigurationId),
    findEnabledBinding(ctx, payment, "membership_deal", payment.membershipId),
  ]);
  // A binding may name a different person. Leave those provisionals for review.
  if (connection?.tenantId !== tenantId || payment.sourceCreatedAt < connection.autoImportAfter ||
      checkout || membership || emails?.size !== 1 || !phones) return;
  const [leadId] = emails;
  if ([...phones].every((id) => id === leadId)) return leadId;
}
