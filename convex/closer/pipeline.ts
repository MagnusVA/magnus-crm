import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const opportunityStatusValidator = v.union(
  v.literal("scheduled"),
  v.literal("in_progress"),
  v.literal("payment_received"),
  v.literal("follow_up_scheduled"),
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
    statusFilter: v.optional(opportunityStatusValidator),
  },
  handler: async (ctx, { statusFilter }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    // Get this closer's opportunities
    const myOpps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId", (q) =>
        q.eq("tenantId", tenantId).eq("assignedCloserId", userId)
      )
      .collect();

    // Apply status filter if provided
    const filtered = statusFilter
      ? myOpps.filter((o) => o.status === statusFilter)
      : myOpps;

    // Enrich with lead and latest meeting data
    const enriched = await Promise.all(
      filtered.map(async (opp) => {
        const lead = await ctx.db.get(opp.leadId);

        // Get the latest meeting for this opportunity
        const latestMeeting = await ctx.db
          .query("meetings")
          .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opp._id))
          .order("desc")
          .first();

        return {
          ...opp,
          leadName: lead?.fullName ?? lead?.email ?? "Unknown",
          leadEmail: lead?.email,
          leadPhone: lead?.phone,
          eventTypeConfigId: opp.eventTypeConfigId,
          latestMeetingId: latestMeeting?._id,
          latestMeetingAt: latestMeeting?.scheduledAt,
          latestMeetingStatus: latestMeeting?.status,
        };
      })
    );

    // Sort by most recent update first
    return enriched.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});
