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
    console.log("[Closer:Calendar] getMeetingsForRange called", { startDate, endDate });
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

    console.log("[Closer:Calendar] opportunity count", { count: oppIds.size });
    if (oppIds.size === 0) {
      console.log("[Closer:Calendar] no opportunities found, returning empty");
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
      if (oppIds.has(meeting.opportunityId) && meeting.status !== "canceled") {
        myMeetings.push(meeting);
      }
    }

    console.log("[Closer:Calendar] meetings found in range", { count: myMeetings.length });

    // Enrich with opportunity and event type data.
    // leadName is now denormalized onto the meeting document (see @plans/caching/caching.md).
    const enriched = await Promise.all(
      myMeetings.map(async (meeting) => {
        const opp = oppMap.get(meeting.opportunityId.toString());
        const eventTypeConfig =
          opp?.eventTypeConfigId ? await ctx.db.get(opp.eventTypeConfigId) : null;

        return {
          meeting,
          leadName: meeting.leadName ?? "Unknown",
          opportunityStatus: opp?.status,
          eventTypeName: eventTypeConfig?.displayName ?? null,
        };
      })
    );

    console.log("[Closer:Calendar] enriched count", { count: enriched.length });
    return enriched;
  },
});
