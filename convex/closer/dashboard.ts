import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const PIPELINE_STATUSES = [
  "scheduled",
  "in_progress",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "payment_received",
  "lost",
  "canceled",
  "no_show",
] as const;

/**
 * Get the closer's next upcoming meeting.
 *
 * Returns the soonest meeting (by scheduledAt) with status "scheduled"
 * that belongs to an opportunity assigned to this closer.
 *
 * Enriched with lead info and opportunity data.
 * Returns null if no upcoming meetings.
 */
export const getNextMeeting = query({
  args: {},
  handler: async (ctx) => {
    console.log("[Closer:Dashboard] getNextMeeting called");
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);
    const now = Date.now();

    for await (const meeting of ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", userId)
          .gte("scheduledAt", now),
      )) {
      if (meeting.status !== "scheduled") {
        continue;
      }

      const opportunity = await ctx.db.get(meeting.opportunityId);
      if (
        !opportunity ||
        opportunity.tenantId !== tenantId ||
        opportunity.assignedCloserId !== userId
      ) {
        continue;
      }

      const [lead, eventTypeConfig] = await Promise.all([
        ctx.db.get(opportunity.leadId),
        opportunity.eventTypeConfigId
          ? ctx.db.get(opportunity.eventTypeConfigId)
          : Promise.resolve(null),
      ]);

      console.log("[Closer:Dashboard] getNextMeeting: next meeting found", {
        meetingId: meeting._id,
        scheduledAt: meeting.scheduledAt,
      });
      return {
        meeting,
        opportunity,
        lead,
        eventTypeName: eventTypeConfig?.displayName ?? null,
      };
    }

    console.log("[Closer:Dashboard] getNextMeeting: no upcoming meeting found");
    return null;
  },
});

/**
 * Get pipeline stage counts for this closer.
 *
 * Returns a breakdown of opportunity counts by status.
 * Powers the pipeline summary strip on the dashboard.
 */
export const getPipelineSummary = query({
  args: {},
  handler: async (ctx) => {
    console.log("[Closer:Dashboard] getPipelineSummary called");
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const counts = {
      scheduled: 0,
      in_progress: 0,
      follow_up_scheduled: 0,
      reschedule_link_sent: 0,
      payment_received: 0,
      lost: 0,
      canceled: 0,
      no_show: 0,
    };
    let total = 0;

    for (const status of PIPELINE_STATUSES) {
      let count = 0;
      for await (const _opportunity of ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_assignedCloserId_and_status", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("assignedCloserId", userId)
            .eq("status", status),
        )) {
        count += 1;
      }
      counts[status] = count;
      total += count;
    }

    console.log("[Closer:Dashboard] getPipelineSummary counts", { total, counts });
    return {
      counts,
      total,
    };
  },
});

/**
 * Get the closer's profile status.
 *
 * Used to determine if the closer is linked to a Calendly member.
 * If not, the dashboard shows a warning banner.
 */
export const getCloserProfile = query({
  args: {},
  handler: async (ctx) => {
    console.log("[Closer:Dashboard] getCloserProfile called");
    const { userId } = await requireTenantUser(ctx, ["closer"]);

    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found");

    console.log("[Closer:Dashboard] getCloserProfile", { userId, isCalendlyLinked: !!user.calendlyUserUri });
    return {
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      isCalendlyLinked: !!user.calendlyUserUri,
      calendlyUserUri: user.calendlyUserUri,
    };
  },
});
