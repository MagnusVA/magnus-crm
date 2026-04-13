import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
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

    const myMeetings: Array<Doc<"meetings">> = [];
    for await (const meeting of ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", userId)
          .gte("scheduledAt", startDate)
          .lt("scheduledAt", endDate)
      )) {
      if (meeting.status !== "canceled") {
        myMeetings.push(meeting);
      }
    }

    console.log("[Closer:Calendar] meetings found in range", { count: myMeetings.length });
    if (myMeetings.length === 0) {
      return [];
    }

    const opportunityIds = [...new Set(myMeetings.map((meeting) => meeting.opportunityId))];
    const opportunities = await Promise.all(
      opportunityIds.map(async (opportunityId) => ({
        opportunityId,
        opportunity: await ctx.db.get(opportunityId),
      })),
    );
    const opportunityById = new Map<
      Id<"opportunities">,
      Doc<"opportunities">
    >();
    const eventTypeConfigIds = new Set<Id<"eventTypeConfigs">>();

    for (const { opportunityId, opportunity } of opportunities) {
      if (!opportunity || opportunity.tenantId !== tenantId) {
        continue;
      }
      opportunityById.set(opportunityId, opportunity);
      if (opportunity.eventTypeConfigId) {
        eventTypeConfigIds.add(opportunity.eventTypeConfigId);
      }
    }

    const eventTypeConfigs = await Promise.all(
      [...eventTypeConfigIds].map(async (eventTypeConfigId) => ({
        eventTypeConfigId,
        eventTypeConfig: await ctx.db.get(eventTypeConfigId),
      })),
    );
    const eventTypeNameById = new Map<Id<"eventTypeConfigs">, string | null>(
      eventTypeConfigs.map(({ eventTypeConfigId, eventTypeConfig }) => [
        eventTypeConfigId,
        eventTypeConfig?.displayName ?? null,
      ]),
    );

    const enriched = myMeetings.map((meeting) => {
      const opportunity = opportunityById.get(meeting.opportunityId);
      const eventTypeName = opportunity?.eventTypeConfigId
        ? eventTypeNameById.get(opportunity.eventTypeConfigId) ?? null
        : null;

      return {
        meeting,
        leadName: meeting.leadName ?? "Unknown",
        opportunityStatus: opportunity?.status,
        eventTypeName,
      };
    });

    console.log("[Closer:Calendar] enriched count", { count: enriched.length });
    return enriched;
  },
});
