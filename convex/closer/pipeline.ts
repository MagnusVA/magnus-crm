import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { PaginationOptions } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const opportunityStatusValidator = v.union(
  v.literal("scheduled"),
  v.literal("in_progress"),
  v.literal("meeting_overran"),
  v.literal("payment_received"),
  v.literal("follow_up_scheduled"),
  v.literal("reschedule_link_sent"),
  v.literal("lost"),
  v.literal("canceled"),
  v.literal("no_show"),
);

/**
 * Build the right paginated index query for the 4 closer filter combinations:
 * (status × date) each map to a dedicated composite index.
 *
 * All four indexes already exist in the schema and are pinned by the admin
 * query — we reuse them here so the closer view has the same filter power.
 */
async function buildPaginatedCloserOpportunityQuery(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  assignedCloserId: Id<"users">,
  filters: {
    statusFilter?: Doc<"opportunities">["status"];
    periodStart?: number;
    periodEnd?: number;
  },
  paginationOpts: PaginationOptions,
) {
  const { statusFilter, periodStart, periodEnd } = filters;
  const hasDate = periodStart !== undefined && periodEnd !== undefined;

  // Status + Date
  if (statusFilter && hasDate) {
    return ctx.db
      .query("opportunities")
      .withIndex(
        "by_tenantId_and_assignedCloserId_and_status_and_createdAt",
        (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("assignedCloserId", assignedCloserId)
            .eq("status", statusFilter)
            .gte("createdAt", periodStart)
            .lt("createdAt", periodEnd),
      )
      .order("desc")
      .paginate(paginationOpts);
  }

  // Date only
  if (hasDate) {
    return ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId_and_createdAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", assignedCloserId)
          .gte("createdAt", periodStart)
          .lt("createdAt", periodEnd),
      )
      .order("desc")
      .paginate(paginationOpts);
  }

  // Status only
  if (statusFilter) {
    return ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId_and_status", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", assignedCloserId)
          .eq("status", statusFilter),
      )
      .order("desc")
      .paginate(paginationOpts);
  }

  // No filters
  return ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_assignedCloserId", (q) =>
      q.eq("tenantId", tenantId).eq("assignedCloserId", assignedCloserId),
    )
    .order("desc")
    .paginate(paginationOpts);
}

/**
 * List the closer's opportunities with optional status and time-period filters.
 *
 * Returns opportunities enriched with:
 * - Lead name and email
 * - Latest/next meeting denormalized fields (already on the opportunity doc)
 */
export const listMyOpportunities = query({
  args: {
    paginationOpts: paginationOptsValidator,
    statusFilter: v.optional(opportunityStatusValidator),
    periodStart: v.optional(v.number()),
    periodEnd: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { paginationOpts, statusFilter, periodStart, periodEnd },
  ) => {
    console.log("[Closer:Pipeline] listMyOpportunities called", {
      statusFilter: statusFilter ?? "all",
      periodStart: periodStart ?? "none",
      periodEnd: periodEnd ?? "none",
    });
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const hasDate = periodStart !== undefined && periodEnd !== undefined;

    const paginatedResult = await buildPaginatedCloserOpportunityQuery(
      ctx,
      tenantId,
      userId,
      {
        statusFilter,
        periodStart: hasDate ? periodStart : undefined,
        periodEnd: hasDate ? periodEnd : undefined,
      },
      paginationOpts,
    );

    const opportunities = paginatedResult.page;

    const leadIds = [
      ...new Set(opportunities.map((opportunity) => opportunity.leadId)),
    ];
    const leads = await Promise.all(
      leadIds.map(async (leadId) => ({
        leadId,
        lead: await ctx.db.get(leadId),
      })),
    );
    const leadById = new Map<
      Id<"leads">,
      { fullName?: string; email: string; phone?: string }
    >();
    for (const { leadId, lead } of leads) {
      if (lead) {
        leadById.set(leadId, lead);
      }
    }

    const enriched = opportunities.map((opportunity) => {
      const lead = leadById.get(opportunity.leadId);

      return {
        ...opportunity,
        leadName: lead?.fullName ?? lead?.email ?? "Unknown",
        leadEmail: lead?.email,
        leadPhone: lead?.phone,
        eventTypeConfigId: opportunity.eventTypeConfigId,
        latestMeetingId: opportunity.latestMeetingId,
        latestMeetingAt: opportunity.latestMeetingAt,
        latestMeetingStatus: undefined,
      };
    });

    // Sort by most recent update first
    console.log("[Closer:Pipeline] listMyOpportunities result", {
      totalOpps: opportunities.length,
      enrichedCount: enriched.length,
    });
    return {
      ...paginatedResult,
      page: enriched.sort((a, b) => b.updatedAt - a.updatedAt),
    };
  },
});
