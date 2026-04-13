import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const opportunityStatusValidator = v.union(
  v.literal("scheduled"),
  v.literal("in_progress"),
  v.literal("payment_received"),
  v.literal("follow_up_scheduled"),
  v.literal("reschedule_link_sent"),
  v.literal("lost"),
  v.literal("canceled"),
  v.literal("no_show"),
);

/**
 * List the closer's opportunities with optional status filter.
 *
 * Returns opportunities enriched with:
 * - Lead name and email
 * - Latest meeting date and status
 * - Time since creation
 */
export const listMyOpportunities = query({
  args: {
    paginationOpts: paginationOptsValidator,
    statusFilter: v.optional(opportunityStatusValidator),
  },
  handler: async (ctx, { paginationOpts, statusFilter }) => {
    console.log("[Closer:Pipeline] listMyOpportunities called", { statusFilter: statusFilter ?? "all" });
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const paginatedResult = statusFilter
      ? await ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_assignedCloserId_and_status", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("assignedCloserId", userId)
              .eq("status", statusFilter),
          )
          .paginate(paginationOpts)
      : await ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_assignedCloserId", (q) =>
            q.eq("tenantId", tenantId).eq("assignedCloserId", userId),
          )
          .paginate(paginationOpts);

    const opportunities = paginatedResult.page;

    const leadIds = [...new Set(opportunities.map((opportunity) => opportunity.leadId))];
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
    console.log("[Closer:Pipeline] listMyOpportunities result", { totalOpps: opportunities.length, enrichedCount: enriched.length });
    return {
      ...paginatedResult,
      page: enriched.sort((a, b) => b.updatedAt - a.updatedAt),
    };
  },
});
