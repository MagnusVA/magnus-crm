import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { listPersonEnrollments, personCustomerStatus } from "../enrollments/read";
import type { EnrollmentStatus } from "../enrollments/validators";
import { isProspectStage } from "../leads/lifecycle";
import { ENROLLMENT_DEAL_LIMIT, ENROLLMENT_PAYMENTS_PER_DEAL_LIMIT } from "../lib/enrollments";
import { reportError } from "../lib/observability/log";
import { buildLeadCustomerSearchText } from "./searchText";
import type { LeadCustomerLifecycle } from "./types";

type ProjectionPatch = Omit<
  Doc<"leadCustomerSearchRows">,
  "_id" | "_creationTime"
>;

// The row reads a person's newest deals up to this, plus one so a customer
// past the enrollment derivation's limit is caught (customerFieldsFromEnrollments).
const PERSON_DEAL_LIMIT = 100;

/**
 * The fields of a person's search row that say whether, since when, and how
 * much they bought (docs/plans/phase-4-customers.md §6.1).
 */
export type CustomerSearchFields = {
  isCustomer: boolean;
  customerStatus: EnrollmentStatus | undefined;
  totalPaidMinor: number | undefined;
  paymentCurrency: string | undefined;
  convertedAt: number | undefined;
  /** The latest payment that isn't disputed; it feeds `latestActivityAt`. */
  latestPaymentAt: number | undefined;
};

export type SearchRowContact = {
  displayName: string;
  email: string | undefined;
  phone: string | undefined;
};

export const NO_CUSTOMER_FIELDS: CustomerSearchFields = {
  isCustomer: false,
  customerStatus: undefined,
  totalPaidMinor: undefined,
  paymentCurrency: undefined,
  convertedAt: undefined,
  latestPaymentAt: undefined,
};

function displayNameForLead(lead: Doc<"leads">) {
  return lead.fullName ?? lead.email ?? lead.phone ?? "Unknown lead";
}

/** The name, email and phone a row shows, from the person alone. */
export function personContact(lead: Doc<"leads">): SearchRowContact {
  return {
    displayName: displayNameForLead(lead),
    email: lead.email,
    phone: lead.phone,
  };
}

export function latestActivityFor(
  lead: Doc<"leads">,
  fields: Pick<CustomerSearchFields, "convertedAt" | "latestPaymentAt">,
  opportunities: Doc<"opportunities">[],
) {
  return Math.max(
    lead.updatedAt,
    lead.firstSeenAt,
    fields.convertedAt ?? 0,
    fields.latestPaymentAt ?? 0,
    ...opportunities.map((opportunity) =>
      opportunity.latestActivityAt ?? computeLatestActivityAt(opportunity),
    ),
  );
}

export function summarizePayments(payments: Doc<"paymentRecords">[]) {
  const nonDisputed = payments.filter((payment) => payment.status !== "disputed");
  const currencies = [...new Set(nonDisputed.map((payment) => payment.currency))];
  return {
    nonDisputed,
    totalPaidMinor: nonDisputed.reduce((sum, payment) => sum + payment.amountMinor, 0),
    paymentCurrency: currencies.length === 1 ? currencies[0] : undefined,
    latestPaymentAt:
      nonDisputed.length > 0
        ? Math.max(...nonDisputed.map((payment) => payment.recordedAt))
        : undefined,
  };
}

/** The person's newest deals, as the row counts them. */
export async function loadPersonDeals(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
): Promise<Doc<"opportunities">[]> {
  return await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .order("desc")
    .take(PERSON_DEAL_LIMIT + 1);
}

/**
 * The customer fields from the person's enrollments and the payments on their
 * deals: a customer has an enrollment, the status is the person-level one
 * (§4.4), the total counts every payment that isn't disputed, and the person
 * became a customer at their earliest enrollment.
 */
export async function customerFieldsFromEnrollments(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
  deals: Doc<"opportunities">[],
): Promise<CustomerSearchFields> {
  const enrollments = await listPersonEnrollments(ctx, tenantId, leadId);
  if (enrollments.length === 0) {
    return NO_CUSTOMER_FIELDS;
  }
  const customerStatus = personCustomerStatus(enrollments);
  const convertedAt = enrollments[0].enrolledAt;
  // A customer's total reads every payment their enrollments derive from, up
  // to the derivation's limits. Past them the total would be partial, so the
  // row shows none and the error is reported. Rebuilding the row runs inside
  // other writes (bookings, deal changes), and one oversized person mustn't
  // make those fail.
  const paymentsByDeal =
    deals.length > ENROLLMENT_DEAL_LIMIT
      ? null
      : await Promise.all(
          deals.map((deal) =>
            ctx.db
              .query("paymentRecords")
              .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", deal._id))
              .take(ENROLLMENT_PAYMENTS_PER_DEAL_LIMIT + 1),
          ),
        );
  if (
    paymentsByDeal === null ||
    paymentsByDeal.some((payments) => payments.length > ENROLLMENT_PAYMENTS_PER_DEAL_LIMIT)
  ) {
    reportError(
      "leadCustomers.projection.total_over_limit",
      new Error("A customer's deals or payments exceed the enrollment derivation's limits"),
      { tenantId, leadId, severity: "warning", fingerprint: "leadCustomers.projection.total_over_limit" },
    );
    return {
      isCustomer: true,
      customerStatus,
      totalPaidMinor: undefined,
      paymentCurrency: undefined,
      convertedAt,
      latestPaymentAt: undefined,
    };
  }
  const payments = paymentsByDeal.flat().filter((payment) => payment.tenantId === tenantId);
  const summary = summarizePayments(payments);
  return {
    isCustomer: true,
    customerStatus,
    totalPaidMinor: summary.totalPaidMinor,
    paymentCurrency: summary.paymentCurrency,
    convertedAt,
    latestPaymentAt: summary.latestPaymentAt,
  };
}

function computeLatestActivityAt(
  opportunity: Pick<
    Doc<"opportunities">,
    | "paymentReceivedAt"
    | "lostAt"
    | "latestMeetingAt"
    | "updatedAt"
    | "createdAt"
  >,
) {
  return Math.max(
    opportunity.paymentReceivedAt ?? 0,
    opportunity.lostAt ?? 0,
    opportunity.latestMeetingAt ?? 0,
    opportunity.updatedAt,
    opportunity.createdAt,
  );
}

function uniqueMeetingIds(opportunities: Doc<"opportunities">[]) {
  const seen = new Set<string>();
  const meetingIds: Array<Id<"meetings">> = [];

  for (const opportunity of opportunities) {
    const ids = [
      opportunity.latestMeetingId,
      opportunity.nextMeetingId,
      opportunity.firstMeetingId,
    ];
    for (const meetingId of ids) {
      if (!meetingId || seen.has(meetingId)) {
        continue;
      }
      seen.add(meetingId);
      meetingIds.push(meetingId);
    }
  }

  return meetingIds;
}

function latestMeetingAtFor(opportunities: Doc<"opportunities">[]) {
  const latestMeetingAt = Math.max(
    0,
    ...opportunities.flatMap((opportunity) =>
      [
        opportunity.latestMeetingAt,
        opportunity.nextMeetingAt,
        opportunity.firstMeetingAt,
      ].filter((value): value is number => value !== undefined),
    ),
  );

  return latestMeetingAt > 0 ? latestMeetingAt : undefined;
}

/**
 * The row's lifecycle. A person below Qualified is a prospect, kept out of
 * the default list and search (docs/plans/phase-1-foundations.md §7.3). A
 * lead the lifecycle backfill hasn't reached counts as a lead.
 */
export function projectedLifecycle(
  lead: Doc<"leads">,
  hasCustomer: boolean,
): LeadCustomerLifecycle {
  if (lead.status === "merged") {
    return "merged";
  }
  if (hasCustomer) {
    return "customer";
  }
  if (isProspectStage(lead.lifecycleStage)) {
    return "prospect";
  }
  return "lead";
}

export function isVisibleLifecycle(lifecycle: LeadCustomerLifecycle): boolean {
  return lifecycle !== "merged" && lifecycle !== "prospect";
}

export async function rebuildLeadCustomerSearchRow(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
) {
  const lead = await ctx.db.get("leads", leadId);
  if (!lead) {
    await hideProjectionRowForMissingLead(ctx, tenantId, leadId);
    return;
  }
  if (lead.tenantId !== tenantId) {
    return;
  }

  const [identifiers, opportunities] = await Promise.all([
    ctx.db
      .query("leadIdentifiers")
      .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
      .order("desc")
      .take(100),
    loadPersonDeals(ctx, tenantId, leadId),
  ]);
  const fields = await customerFieldsFromEnrollments(ctx, tenantId, leadId, opportunities);
  const contact = personContact(lead);

  const meetingIds = uniqueMeetingIds(opportunities);
  const lifecycle = projectedLifecycle(lead, fields.isCustomer);
  const row: ProjectionPatch = {
    tenantId,
    leadId,
    lifecycle,
    isSearchVisible: isVisibleLifecycle(lifecycle),
    leadStatus: lead.status,
    customerStatus: fields.customerStatus,
    displayName: contact.displayName,
    email: contact.email,
    phone: contact.phone,
    primaryIdentifier:
      identifiers[0]?.rawValue ??
      identifiers[0]?.value ??
      lead.socialHandles?.[0]?.handle,
    searchText: buildLeadCustomerSearchText({
      lead,
      identifiers,
      opportunities,
      meetingIds,
    }),
    opportunityCount: opportunities.length,
    wonOpportunityCount: opportunities.filter(
      (opportunity) => opportunity.status === "payment_received",
    ).length,
    meetingCount: meetingIds.length,
    latestMeetingAt: latestMeetingAtFor(opportunities),
    latestActivityAt: latestActivityFor(lead, fields, opportunities),
    firstSeenAt: lead.firstSeenAt,
    convertedAt: fields.convertedAt,
    totalPaidMinor: fields.totalPaidMinor,
    paymentCurrency: fields.paymentCurrency,
    updatedAt: Date.now(),
  };

  const existing = await ctx.db
    .query("leadCustomerSearchRows")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .unique();

  if (existing) {
    await ctx.db.patch("leadCustomerSearchRows", existing._id, row);
  } else {
    await ctx.db.insert("leadCustomerSearchRows", row);
  }
}

export async function hideProjectionRowForMissingLead(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
) {
  const existing = await ctx.db
    .query("leadCustomerSearchRows")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .unique();

  if (!existing) {
    return;
  }

  await ctx.db.patch("leadCustomerSearchRows", existing._id, {
    lifecycle: "merged",
    isSearchVisible: false,
    updatedAt: Date.now(),
  });
}
