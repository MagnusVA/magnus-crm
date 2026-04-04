import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

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

    // Get this closer's scheduled opportunities
    const myOpps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId", (q) =>
        q.eq("tenantId", tenantId).eq("assignedCloserId", userId)
      )
      .collect();
    const scheduledOpps = myOpps.filter((opportunity) => opportunity.status === "scheduled");
    console.log("[Closer:Dashboard] getNextMeeting opp count", { total: myOpps.length, scheduled: scheduledOpps.length });

    if (scheduledOpps.length === 0) return null;

    const oppIds = new Set(scheduledOpps.map((opportunity) => opportunity._id));
    const opportunityById = new Map(
      scheduledOpps.map((opportunity) => [opportunity._id, opportunity]),
    );

    // Scan upcoming tenant meetings in chronological order and stop at the
    // first scheduled meeting owned by this closer.
    const upcomingMeetings = ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q.eq("tenantId", tenantId).gte("scheduledAt", now)
      );

    let nextMeeting = null;
    for await (const meeting of upcomingMeetings) {
      if (meeting.status !== "scheduled") {
        continue;
      }
      if (!oppIds.has(meeting.opportunityId)) {
        continue;
      }
      nextMeeting = meeting;
      break;
    }

    if (!nextMeeting) {
      console.log("[Closer:Dashboard] getNextMeeting: no upcoming meeting found");
      return null;
    }
    console.log("[Closer:Dashboard] getNextMeeting: next meeting found", { meetingId: nextMeeting._id, scheduledAt: nextMeeting.scheduledAt });

    const opportunity = opportunityById.get(nextMeeting.opportunityId);
    const lead = opportunity ? await ctx.db.get(opportunity.leadId) : null;
    const eventTypeConfig =
      opportunity?.eventTypeConfigId
        ? await ctx.db.get(opportunity.eventTypeConfigId)
        : null;

    return {
      meeting: nextMeeting,
      opportunity,
      lead,
      eventTypeName: eventTypeConfig?.displayName ?? null,
    };
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

    const myOpps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId", (q) =>
        q.eq("tenantId", tenantId).eq("assignedCloserId", userId)
      )
      .collect();

    const counts = {
      scheduled: 0,
      in_progress: 0,
      follow_up_scheduled: 0,
      payment_received: 0,
      lost: 0,
      canceled: 0,
      no_show: 0,
    };

    for (const opp of myOpps) {
      if (opp.status in counts) {
        counts[opp.status as keyof typeof counts]++;
      }
    }

    console.log("[Closer:Dashboard] getPipelineSummary counts", { total: myOpps.length, counts });
    return {
      counts,
      total: myOpps.length,
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
