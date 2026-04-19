import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { requireTenantUser } from "../requireTenantUser";
import { validateTransition } from "../lib/statusTransitions";
import { cancelMeetingAttendanceCheck } from "../lib/attendanceChecks";
import { getStoredMeetingJoinUrl } from "../lib/meetingLocation";
import { emitDomainEvent } from "../lib/domainEvents";
import { assertOverranReviewStillPending } from "../lib/overranReviewGuards";
import {
  replaceMeetingAggregate,
  replaceOpportunityAggregate,
} from "../reporting/writeHooks";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "../lib/tenantStatsHelper";

export async function loadMeetingContext(
  ctx: MutationCtx,
  meetingId: Id<"meetings">,
  tenantId: Id<"tenants">,
) {
  const meeting = await ctx.db.get(meetingId);
  if (!meeting || meeting.tenantId !== tenantId) {
    throw new Error("Meeting not found");
  }

  const opportunity = await ctx.db.get(meeting.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Opportunity not found");
  }

  return { meeting, opportunity };
}

/**
 * Start a meeting.
 *
 * Transitions the meeting and opportunity to "in_progress".
 * Returns the meeting join URL so the frontend can open it in a new tab.
 *
 * Only closers can start meetings (on their own assignments).
 */
export const startMeeting = mutation({
  args: { meetingId: v.id("meetings") },
  handler: async (ctx, { meetingId }) => {
    console.log("[Closer:Meeting] startMeeting called", { meetingId });
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);
    console.log("[Closer:Meeting] startMeeting auth check passed", { userId });
    const { meeting, opportunity } = await loadMeetingContext(ctx, meetingId, tenantId);

    // Verify this is the closer's meeting
    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    // Validate status transitions
    console.log("[Closer:Meeting] startMeeting status checks", { meetingStatus: meeting.status, opportunityStatus: opportunity.status });
    if (meeting.status !== "scheduled") {
      throw new Error(`Cannot start a meeting with status "${meeting.status}"`);
    }

    if (!validateTransition(opportunity.status, "in_progress")) {
      throw new Error(
        `Cannot start a meeting for opportunity with status "${opportunity.status}"`,
      );
    }

    const now = Date.now();
    const windowCloseMs = meeting.scheduledAt + meeting.durationMinutes * 60_000;
    if (now > windowCloseMs) {
      throw new Error(
        "Meeting window has passed. This meeting can no longer be started directly.",
      );
    }

    const lateStartDurationMs = Math.max(0, now - meeting.scheduledAt);

    const oldOpportunity = opportunity;
    const oldMeeting = meeting;
    await cancelMeetingAttendanceCheck(
      ctx,
      meeting.attendanceCheckId,
      "closer.startMeeting",
    );
    console.log("[Closer:Meeting] startMeeting transitioning to in_progress", {
      meetingId,
      opportunityId: opportunity._id,
    });
    await ctx.db.patch(opportunity._id, {
      status: "in_progress",
      updatedAt: now,
    });
    await replaceOpportunityAggregate(ctx, oldOpportunity, opportunity._id);

    await ctx.db.patch(meetingId, {
      status: "in_progress",
      startedAt: now,
      startedAtSource: "closer" as const,
      lateStartDurationMs,
    });
    await replaceMeetingAggregate(ctx, oldMeeting, meetingId);
    await updateOpportunityMeetingRefs(ctx, opportunity._id);
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunity._id,
      eventType: "opportunity.status_changed",
      source: "closer",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "in_progress",
      occurredAt: now,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "meeting",
      entityId: meetingId,
      eventType: "meeting.started",
      source: "closer",
      actorUserId: userId,
      fromStatus: meeting.status,
      toStatus: "in_progress",
      occurredAt: now,
    });

    const joinUrl = getStoredMeetingJoinUrl(meeting);
    console.log("[Closer:Meeting] startMeeting completed", {
      hasMeetingUrl: !!joinUrl,
    });
    return {
      meetingJoinUrl: joinUrl ?? null,
      lateStartDurationMs,
    };
  },
});

export const stopMeeting = mutation({
  args: { meetingId: v.id("meetings") },
  handler: async (ctx, { meetingId }) => {
    console.log("[Closer:Meeting] stopMeeting called", { meetingId });
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const { meeting, opportunity } = await loadMeetingContext(ctx, meetingId, tenantId);

    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }
    if (meeting.status !== "in_progress") {
      throw new Error(`Cannot stop a meeting with status "${meeting.status}"`);
    }

    const now = Date.now();
    const scheduledEndMs =
      meeting.scheduledAt + meeting.durationMinutes * 60 * 1000;
    const exceededScheduledDurationMs = Math.max(0, now - scheduledEndMs);

    await ctx.db.patch(meetingId, {
      status: "completed",
      stoppedAt: now,
      stoppedAtSource: "closer" as const,
      completedAt: now,
      exceededScheduledDurationMs,
    });
    await replaceMeetingAggregate(ctx, meeting, meetingId);
    await updateOpportunityMeetingRefs(ctx, opportunity._id);
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "meeting",
      entityId: meetingId,
      eventType: "meeting.stopped",
      source: role === "closer" ? "closer" : "admin",
      actorUserId: userId,
      fromStatus: meeting.status,
      toStatus: "completed",
      occurredAt: now,
      metadata: {
        actualDurationMs:
          meeting.startedAt !== undefined ? now - meeting.startedAt : undefined,
        exceededScheduledDurationMs,
      },
    });

    console.log("[Closer:Meeting] stopMeeting completed", {
      meetingId,
      exceededScheduledDurationMs,
      exceededScheduledDuration: exceededScheduledDurationMs > 0,
    });

    return {
      exceededScheduledDurationMs,
      exceededScheduledDuration: exceededScheduledDurationMs > 0,
    };
  },
});

/**
 * OUTCOME MUTATION CONTRACT
 *
 * Outcome mutations operate on the opportunity only. They MUST NOT write:
 * - meetings.startedAt / startedAtSource
 * - meetings.stoppedAt / stoppedAtSource
 * - meetings.completedAt
 * - meetings.status
 *
 * Rationale: a closer may record an outcome before the conversation is
 * actually over. The explicit End Meeting control is the only closer-facing
 * action that should end the meeting lifecycle.
 */

/**
 * Mark an opportunity as lost.
 *
 * Transitions the opportunity to "lost" status with an optional reason.
 * This is a terminal state — no further transitions allowed.
 *
 * Only closers can mark their own opportunities as lost.
 */
export const markAsLost = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { opportunityId, reason }) => {
    console.log("[Closer:Meeting] markAsLost called", { opportunityId });
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);
    console.log("[Closer:Meeting] markAsLost auth check passed", { userId });

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }

    // Validate the transition
    console.log("[Closer:Meeting] markAsLost current status", { currentStatus: opportunity.status });
    if (opportunity.status === "meeting_overran") {
      await assertOverranReviewStillPending(ctx, opportunity._id);
    }
    if (!validateTransition(opportunity.status, "lost")) {
      throw new Error(`Cannot mark as lost from status "${opportunity.status}"`);
    }

    const normalizedReason = reason?.trim();
    const now = Date.now();
    const patch: Partial<Doc<"opportunities">> = {
      status: "lost",
      updatedAt: now,
      lostAt: now,
      lostByUserId: userId,
    };
    if (normalizedReason) {
      patch.lostReason = normalizedReason;
    }

    await ctx.db.patch(opportunityId, patch);
    await replaceOpportunityAggregate(ctx, opportunity, opportunityId);
    await updateTenantStats(ctx, tenantId, {
      activeOpportunities: isActiveOpportunityStatus(opportunity.status) ? -1 : 0,
      lostDeals: 1,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.marked_lost",
      source: "closer",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "lost",
      reason: normalizedReason,
      occurredAt: now,
    });
    console.log("[Closer:Meeting] markAsLost patch applied", { opportunityId, newStatus: "lost", hasReason: !!normalizedReason });
  },
});

export const saveFathomLink = mutation({
  args: {
    meetingId: v.id("meetings"),
    fathomLink: v.string(),
  },
  handler: async (ctx, { meetingId, fathomLink: rawLink }) => {
    console.log("[Closer:Meeting] saveFathomLink called", { meetingId });
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    console.log("[Closer:Meeting] saveFathomLink auth check passed", { userId, role });

    const { opportunity } = await loadMeetingContext(ctx, meetingId, tenantId);

    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    const fathomLink = rawLink.trim();
    if (!fathomLink) {
      throw new Error("Fathom link is required");
    }

    const now = Date.now();
    await ctx.db.patch(meetingId, {
      fathomLink,
      fathomLinkSavedAt: now,
    });

    console.log("[Closer:Meeting] saveFathomLink completed", {
      meetingId,
      fathomLinkSavedAt: now,
    });
  },
});
