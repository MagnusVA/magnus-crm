import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const PIPELINE_STATUSES = [
  "scheduled",
  "in_progress",
  "meeting_overran",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "payment_received",
  "lost",
  "canceled",
  "no_show",
] as const;

type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

function emptyCounts(): Record<PipelineStatus, number> {
  return {
    scheduled: 0,
    in_progress: 0,
    meeting_overran: 0,
    follow_up_scheduled: 0,
    reschedule_link_sent: 0,
    payment_received: 0,
    lost: 0,
    canceled: 0,
    no_show: 0,
  };
}

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
 * Returns a breakdown of opportunity counts by status. Powers the pipeline
 * summary strip on the dashboard.
 *
 * **Date filtering** — when `startDate` and `endDate` are both provided,
 * counts are restricted to opportunities that have at least one meeting whose
 * `scheduledAt` falls inside [startDate, endDate). This mirrors the calendar
 * view's filter so the strip and the schedule below it always describe the
 * same time slice. When neither is provided (or the closer-pipeline page
 * calls without args), the original all-time behaviour applies.
 */
export const getPipelineSummary = query({
  args: {
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  handler: async (ctx, { startDate, endDate }) => {
    console.log("[Closer:Dashboard] getPipelineSummary called", {
      startDate,
      endDate,
    });
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    // ── Filtered mode ──────────────────────────────────────────────────────
    // Resolve the closer's meetings inside the requested range, then count
    // their parent opportunities by status. Uses the same index the calendar
    // does, so this is bounded by what's on screen there.
    if (startDate !== undefined && endDate !== undefined) {
      if (startDate >= endDate) {
        throw new Error("startDate must be earlier than endDate");
      }

      const opportunityIds = new Set<Id<"opportunities">>();
      for await (const meeting of ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("assignedCloserId", userId)
            .gte("scheduledAt", startDate)
            .lt("scheduledAt", endDate),
        )) {
        opportunityIds.add(meeting.opportunityId);
      }

      const counts = emptyCounts();
      let total = 0;

      for (const opportunityId of opportunityIds) {
        const opportunity = await ctx.db.get(opportunityId);
        if (!opportunity || opportunity.tenantId !== tenantId) {
          continue;
        }
        // Belt-and-braces: only count opportunities still owned by this closer.
        if (opportunity.assignedCloserId !== userId) {
          continue;
        }
        counts[opportunity.status as PipelineStatus] += 1;
        total += 1;
      }

      console.log("[Closer:Dashboard] getPipelineSummary (filtered) counts", {
        total,
        counts,
        meetingsScanned: opportunityIds.size,
      });
      return { counts, total };
    }

    // ── All-time mode (legacy / pipeline page) ─────────────────────────────
    const counts = emptyCounts();
    let total = 0;

    for (const status of PIPELINE_STATUSES) {
      let count = 0;
      for await (const opportunity of ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_assignedCloserId_and_status", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("assignedCloserId", userId)
            .eq("status", status),
        )) {
        count += opportunity.status === status ? 1 : 0;
      }
      counts[status] = count;
      total += count;
    }

    console.log("[Closer:Dashboard] getPipelineSummary (all-time) counts", {
      total,
      counts,
    });
    return { counts, total };
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
