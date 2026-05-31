import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type {
  LeadCustomerLifecycleFilter,
  LeadCustomerSearchRowDto,
} from "./types";

export type ProjectedEntityMatch = {
  row: Doc<"leadCustomerSearchRows">;
  selectedOpportunityId?: Id<"opportunities">;
  selectedMeetingId?: Id<"meetings">;
};

export function lifecycleMatchesFilter(
  lifecycle: Doc<"leadCustomerSearchRows">["lifecycle"],
  filter: LeadCustomerLifecycleFilter | undefined,
) {
  return filter === undefined || filter === "all" || lifecycle === filter;
}

export function toLeadCustomerSearchRowDto(
  match: ProjectedEntityMatch,
): LeadCustomerSearchRowDto {
  const { row } = match;

  return {
    _id: row._id,
    leadId: row.leadId,
    customerId: row.customerId,
    lifecycle: row.lifecycle,
    displayName: row.displayName,
    email: row.email,
    phone: row.phone,
    primaryIdentifier: row.primaryIdentifier,
    leadStatus: row.leadStatus,
    customerStatus: row.customerStatus,
    opportunityCount: row.opportunityCount,
    wonOpportunityCount: row.wonOpportunityCount,
    meetingCount: row.meetingCount,
    latestMeetingAt: row.latestMeetingAt,
    latestActivityAt: row.latestActivityAt,
    firstSeenAt: row.firstSeenAt,
    convertedAt: row.convertedAt,
    totalPaidMinor: row.totalPaidMinor,
    paymentCurrency: row.paymentCurrency,
    selectedOpportunityId: match.selectedOpportunityId,
    selectedMeetingId: match.selectedMeetingId,
  };
}

export async function getProjectedRowForLead(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
): Promise<Doc<"leadCustomerSearchRows"> | null> {
  return await ctx.db
    .query("leadCustomerSearchRows")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .unique();
}

export async function resolveDirectEntityIdentifier(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rawTerm: string,
): Promise<ProjectedEntityMatch | null> {
  const term = rawTerm.trim();

  const leadId = ctx.db.normalizeId("leads", term);
  if (leadId) {
    const row = await getProjectedRowForLead(ctx, tenantId, leadId);
    return row ? { row } : null;
  }

  const customerId = ctx.db.normalizeId("customers", term);
  if (customerId) {
    const customer = await ctx.db.get(customerId);
    if (!customer || customer.tenantId !== tenantId) {
      return null;
    }
    const row = await getProjectedRowForLead(ctx, tenantId, customer.leadId);
    return row ? { row } : null;
  }

  const opportunityId = ctx.db.normalizeId("opportunities", term);
  if (opportunityId) {
    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      return null;
    }
    const row = await getProjectedRowForLead(ctx, tenantId, opportunity.leadId);
    return row
      ? { row, selectedOpportunityId: opportunity._id }
      : null;
  }

  const meetingId = ctx.db.normalizeId("meetings", term);
  if (meetingId) {
    const meeting = await ctx.db.get(meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      return null;
    }
    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      return null;
    }
    const row = await getProjectedRowForLead(ctx, tenantId, opportunity.leadId);
    return row
      ? {
          row,
          selectedOpportunityId: opportunity._id,
          selectedMeetingId: meeting._id,
        }
      : null;
  }

  return null;
}
