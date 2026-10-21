import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { BillingLabels } from "../billing/enrichment";
import { MAX_NEW_CUSTOMER_SCAN_ROWS, type NewCustomerCount } from "../dashboard/adminStats";
import { readLiveQueryRows } from "../lib/liveQueryBounds";
import {
  type CustomerSearchFields,
  NO_CUSTOMER_FIELDS,
  personContact,
  type SearchRowContact,
  summarizePayments,
} from "../leadCustomers/projection";
import { MAX_CONVERSION_SCAN_ROWS, type LeadConversionList } from "../reporting/leadConversion";

// How the readers computed each number from the customer rows before Phase 4
// PR 2 switched them to the person and their enrollments. Only the parity
// queries read this (docs/plans/phase-4-customers.md §10.3); the narrow
// removes it with them.

const CUSTOMER_PAYMENT_LIMIT = 100;

function tenantOwned<T extends { tenantId: Id<"tenants"> }>(
  doc: T | null,
  tenantId: Id<"tenants">,
): T | null {
  return doc && doc.tenantId === tenantId ? doc : null;
}

/** Leads & Conversions: the conversions in [startDate, endDate), from the customer rows. */
export async function conversionsFromCustomers(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  startDate: number,
  endDate: number,
): Promise<LeadConversionList> {
  const customerRows = await ctx.db
    .query("customers")
    .withIndex("by_tenantId_and_convertedAt", (q) =>
      q.eq("tenantId", tenantId).gte("convertedAt", startDate).lt("convertedAt", endDate),
    )
    .take(MAX_CONVERSION_SCAN_ROWS + 1);
  return {
    conversions: customerRows.slice(0, MAX_CONVERSION_SCAN_ROWS).map((customer) => ({
      leadId: customer.leadId,
      convertedAt: customer.convertedAt,
      winningOpportunityId: customer.winningOpportunityId,
      convertedByUserId: customer.convertedByUserId,
    })),
    isTruncated: customerRows.length > MAX_CONVERSION_SCAN_ROWS,
  };
}

/** Search row: the customer fields from the person's customer row and its payments. */
export async function customerFieldsFromCustomerRow(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
): Promise<{ customer: Doc<"customers"> | null; fields: CustomerSearchFields }> {
  const customer = await ctx.db
    .query("customers")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .first();
  if (!customer) {
    return { customer: null, fields: NO_CUSTOMER_FIELDS };
  }
  const paymentRows = await ctx.db
    .query("paymentRecords")
    .withIndex("by_customerId_and_recordedAt", (q) =>
      q.eq("customerId", customer._id),
    )
    .order("desc")
    .take(CUSTOMER_PAYMENT_LIMIT);
  const summary = summarizePayments(paymentRows);
  return {
    customer,
    fields: {
      isCustomer: true,
      customerStatus: customer.status,
      totalPaidMinor:
        customer.totalPaidMinor ??
        (summary.nonDisputed.length > 0 ? summary.totalPaidMinor : undefined),
      paymentCurrency: customer.paymentCurrency ?? summary.paymentCurrency,
      convertedAt: customer.convertedAt,
      latestPaymentAt: summary.latestPaymentAt,
    },
  };
}

/** Search row: the name, email and phone, from the customer copy first. */
export function customerCopyContact(
  lead: Doc<"leads">,
  customer: Doc<"customers"> | null,
): SearchRowContact {
  const person = personContact(lead);
  return {
    displayName: customer?.fullName ?? person.displayName,
    email: customer?.email ?? person.email,
    phone: customer?.phone ?? person.phone,
  };
}

/** Billing: the customer name, email and phone from the customer copy. */
export function customerBillingLabels(customer: Doc<"customers"> | null): BillingLabels {
  if (!customer) {
    return { fullName: null, email: null, phone: null };
  }
  return {
    fullName: customer.fullName || null,
    email: customer.email || null,
    phone: customer.phone ?? null,
  };
}

async function firstTenantOpportunity(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  ids: Array<Id<"opportunities"> | undefined>,
) {
  for (const id of ids) {
    const opportunity = id ? tenantOwned(await ctx.db.get("opportunities", id), tenantId) : null;
    if (opportunity) {
      return opportunity;
    }
  }
  return null;
}

async function firstTenantMeeting(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  ids: Array<Id<"meetings"> | undefined>,
) {
  for (const id of ids) {
    const meeting = id ? tenantOwned(await ctx.db.get("meetings", id), tenantId) : null;
    if (meeting) {
      return meeting;
    }
  }
  return null;
}

/**
 * Billing: a payment's customer row, deal and meeting. The payment's customer,
 * else its deal's person's; the customer's winning deal and meeting are the
 * fallbacks before the deal's first and latest meeting.
 */
export async function resolveBillingFromCustomer(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  payment: Doc<"paymentRecords">,
) {
  const directCustomer = payment.customerId
    ? tenantOwned(await ctx.db.get("customers", payment.customerId), tenantId)
    : null;
  const opportunity = await firstTenantOpportunity(ctx, tenantId, [
    payment.opportunityId,
    payment.originatingOpportunityId,
    directCustomer?.winningOpportunityId,
  ]);
  const fallbackCustomer = opportunity
    ? await ctx.db
        .query("customers")
        .withIndex("by_tenantId_and_leadId", (q) =>
          q.eq("tenantId", tenantId).eq("leadId", opportunity.leadId),
        )
        .first()
    : null;
  const customer = directCustomer ?? tenantOwned(fallbackCustomer, tenantId);
  const meeting = await firstTenantMeeting(ctx, tenantId, [
    payment.meetingId,
    customer?.winningMeetingId,
    opportunity?.firstMeetingId,
    opportunity?.latestMeetingId,
  ]);
  return { customer, opportunity, meeting };
}

/**
 * Customers converted in [periodStart, periodEnd), from the customer rows:
 * the admin dashboard's count before PR 2, for the parity queries.
 */
export async function countNewCustomersFromCustomers(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  periodStart: number,
  periodEnd: number,
): Promise<NewCustomerCount> {
  // Bounded by rows and by bytes; either stop marks the count truncated.
  const { rows, capped } = await readLiveQueryRows(
    ctx.db
      .query("customers")
      .withIndex("by_tenantId_and_convertedAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("convertedAt", periodStart)
          .lt("convertedAt", periodEnd),
      ),
    MAX_NEW_CUSTOMER_SCAN_ROWS,
  );
  return { count: rows.length, isTruncated: capped };
}
