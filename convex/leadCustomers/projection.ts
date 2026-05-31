import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { buildLeadCustomerSearchText } from "./searchText";

type ProjectionPatch = Omit<
  Doc<"leadCustomerSearchRows">,
  "_id" | "_creationTime"
>;

function displayNameForLead(lead: Doc<"leads">) {
  return lead.fullName ?? lead.email ?? lead.phone ?? "Unknown lead";
}

function latestActivityFor(
  lead: Doc<"leads">,
  customer: Doc<"customers"> | null,
  opportunities: Doc<"opportunities">[],
  paymentRows: Doc<"paymentRecords">[],
) {
  return Math.max(
    lead.updatedAt,
    lead.firstSeenAt,
    customer?.convertedAt ?? 0,
    ...paymentRows.map((payment) => payment.recordedAt),
    ...opportunities.map((opportunity) =>
      opportunity.latestActivityAt ?? computeLatestActivityAt(opportunity),
    ),
  );
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

export async function rebuildLeadCustomerSearchRow(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
) {
  const lead = await ctx.db.get(leadId);
  if (!lead) {
    await hideProjectionRowForMissingLead(ctx, tenantId, leadId);
    return;
  }
  if (lead.tenantId !== tenantId) {
    return;
  }

  const [customer, identifiers, opportunities] = await Promise.all([
    ctx.db
      .query("customers")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", leadId),
      )
      .first(),
    ctx.db
      .query("leadIdentifiers")
      .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
      .order("desc")
      .take(100),
    ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", leadId),
      )
      .order("desc")
      .take(100),
  ]);

  const paymentRows = customer
    ? await ctx.db
        .query("paymentRecords")
        .withIndex("by_customerId_and_recordedAt", (q) =>
          q.eq("customerId", customer._id),
        )
        .order("desc")
        .take(100)
    : [];
  const nonDisputedPaymentRows = paymentRows.filter(
    (payment) => payment.status !== "disputed",
  );
  const paymentCurrencies = [
    ...new Set(nonDisputedPaymentRows.map((payment) => payment.currency)),
  ];
  const totalPaidMinor =
    customer?.totalPaidMinor ??
    (nonDisputedPaymentRows.length > 0
      ? nonDisputedPaymentRows.reduce(
          (sum, payment) => sum + payment.amountMinor,
          0,
        )
      : undefined);
  const paymentCurrency =
    customer?.paymentCurrency ??
    (paymentCurrencies.length === 1 ? paymentCurrencies[0] : undefined);

  const meetingIds = uniqueMeetingIds(opportunities);
  const lifecycle =
    lead.status === "merged" ? "merged" : customer ? "customer" : "lead";
  const row: ProjectionPatch = {
    tenantId,
    leadId,
    customerId: customer?._id,
    lifecycle,
    isSearchVisible: lifecycle !== "merged",
    leadStatus: lead.status,
    customerStatus: customer?.status,
    displayName: customer?.fullName ?? displayNameForLead(lead),
    email: customer?.email ?? lead.email,
    phone: customer?.phone ?? lead.phone,
    primaryIdentifier:
      identifiers[0]?.rawValue ??
      identifiers[0]?.value ??
      lead.socialHandles?.[0]?.handle,
    searchText: buildLeadCustomerSearchText({
      lead,
      customer,
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
    latestActivityAt: latestActivityFor(
      lead,
      customer,
      opportunities,
      nonDisputedPaymentRows,
    ),
    firstSeenAt: lead.firstSeenAt,
    convertedAt: customer?.convertedAt,
    totalPaidMinor,
    paymentCurrency,
    updatedAt: Date.now(),
  };

  const existing = await ctx.db
    .query("leadCustomerSearchRows")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, row);
  } else {
    await ctx.db.insert("leadCustomerSearchRows", row);
  }

  console.log("[LeadCustomers:Projection] rebuilt row", {
    tenantId,
    leadId,
    lifecycle,
    opportunityCount: row.opportunityCount,
    meetingCount: row.meetingCount,
  });
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

  await ctx.db.patch(existing._id, {
    lifecycle: "merged",
    isSearchVisible: false,
    updatedAt: Date.now(),
  });
}
