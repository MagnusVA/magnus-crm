import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * Get all of a closer's meetings within a date range.
 *
 * Returns meetings enriched with lead name and opportunity status.
 * Used by the calendar view to render meeting blocks.
 *
 * Args:
 * - startDate: Unix ms timestamp for the start of the range
 * - endDate: Unix ms timestamp for the end of the range
 */
export const getMeetingsForRange = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    if (startDate >= endDate) {
      throw new Error("startDate must be earlier than endDate");
    }

    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    // Get this closer's opportunities (needed to filter meetings)
    const myOpps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId", (q) =>
        q.eq("tenantId", tenantId).eq("assignedCloserId", userId)
      )
      .collect();

    const oppIds = new Set(myOpps.map((o) => o._id));
    const oppMap = new Map(myOpps.map((o) => [o._id.toString(), o]));

    if (oppIds.size === 0) {
      return [];
    }

    // Walk the tenant's meetings in the requested range and keep only the
    // meetings that belong to this closer's opportunities.
    const meetings = ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("scheduledAt", startDate)
          .lt("scheduledAt", endDate)
      );

    const myMeetings = [];
    for await (const meeting of meetings) {
      if (oppIds.has(meeting.opportunityId)) {
        myMeetings.push(meeting);
      }
    }

    // Enrich with lead and opportunity data
    const enriched = await Promise.all(
      myMeetings.map(async (meeting) => {
        const opp = oppMap.get(meeting.opportunityId.toString());
        const lead = opp ? await ctx.db.get(opp.leadId) : null;
        const eventTypeConfig =
          opp?.eventTypeConfigId ? await ctx.db.get(opp.eventTypeConfigId) : null;

        return {
          meeting,
          leadName: lead?.fullName ?? lead?.email ?? "Unknown",
          leadEmail: lead?.email,
          opportunityStatus: opp?.status,
          eventTypeName: eventTypeConfig?.displayName ?? null,
        };
      })
    );

    return enriched;
  },
});
