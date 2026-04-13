import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { requireTenantUser } from "../requireTenantUser";
import { validateTransition } from "../lib/statusTransitions";
import { getStoredMeetingJoinUrl } from "../lib/meetingLocation";
import { emitDomainEvent } from "../lib/domainEvents";
import {
  replaceMeetingAggregate,
  replaceOpportunityAggregate,
} from "../reporting/writeHooks";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "../lib/tenantStatsHelper";

async function loadMeetingContext(
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

function normalizeRequiredString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Reason is required");
  }
  return trimmed;
}

/**
 * Update meeting notes.
 *
 * Called by the auto-saving notes textarea on the meeting detail page.
 * Debounced on the client side (typically 500ms–1s).
 *
 * Accessible by closers (own meetings) and admins (any meeting).
 */
export const updateMeetingNotes = mutation({
  args: {
    meetingId: v.id("meetings"),
    notes: v.string(),
  },
  handler: async (ctx, { meetingId, notes }) => {
    console.log("[Closer:Meeting] updateMeetingNotes called", { meetingId });
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    console.log("[Closer:Meeting] updateMeetingNotes auth check passed", { userId, role });
    const { opportunity } = await loadMeetingContext(ctx, meetingId, tenantId);

    // Closer authorization: only own meetings
    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    await ctx.db.patch(meetingId, { notes });
    console.log("[Closer:Meeting] updateMeetingNotes completed", { meetingId });
  },
});

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
    const lateStartDurationMs = Math.max(0, now - meeting.scheduledAt);
    const oldOpportunity = opportunity;
    const oldMeeting = meeting;
    console.log("[Closer:Meeting] startMeeting transitioning to in_progress", { meetingId, opportunityId: opportunity._id });
    await ctx.db.patch(opportunity._id, {
      status: "in_progress",
      updatedAt: now,
    });
    await replaceOpportunityAggregate(ctx, oldOpportunity, opportunity._id);

    await ctx.db.patch(meetingId, {
      status: "in_progress",
      startedAt: now,
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
    console.log("[Closer:Meeting] startMeeting completed", { hasMeetingUrl: !!joinUrl });
    return {
      meetingJoinUrl: joinUrl ?? null,
      lateStartDurationMs,
    };
  },
});

export const setLateStartReason = mutation({
  args: {
    meetingId: v.id("meetings"),
    reason: v.string(),
  },
  handler: async (ctx, { meetingId, reason }) => {
    console.log("[Closer:Meeting] setLateStartReason called", { meetingId });
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);
    const { meeting, opportunity } = await loadMeetingContext(ctx, meetingId, tenantId);

    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }
    if (meeting.status !== "in_progress") {
      throw new Error("Meeting must be in progress to set late start reason");
    }
    if (!meeting.lateStartDurationMs || meeting.lateStartDurationMs <= 0) {
      throw new Error("Meeting was not started late");
    }

    await ctx.db.patch(meetingId, {
      lateStartReason: normalizeRequiredString(reason),
    });
    console.log("[Closer:Meeting] setLateStartReason completed", { meetingId });
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
    const overranDurationMs = Math.max(0, now - scheduledEndMs);

    await ctx.db.patch(meetingId, {
      status: "completed",
      stoppedAt: now,
      completedAt: now,
      overranDurationMs,
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
        overranDurationMs,
      },
    });

    console.log("[Closer:Meeting] stopMeeting completed", {
      meetingId,
      overranDurationMs,
      wasOverran: overranDurationMs > 0,
    });

    return {
      overranDurationMs,
      wasOverran: overranDurationMs > 0,
    };
  },
});

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
    if (!validateTransition(opportunity.status, "lost")) {
      throw new Error(
        `Cannot mark as lost from status "${opportunity.status}". ` +
        `Only "in_progress" opportunities can be marked as lost.`
      );
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

/**
 * Set or clear the meeting outcome classification.
 *
 * The outcome is a structured tag that captures the closer's assessment
 * of the lead's intent after a meeting. It's separate from the
 * opportunity status (which tracks the deal lifecycle).
 *
 * Pass `undefined` for meetingOutcome to clear the tag.
 *
 * Only the assigned closer or an admin can update the outcome.
 */
export const updateMeetingOutcome = mutation({
  args: {
    meetingId: v.id("meetings"),
    meetingOutcome: v.optional(
      v.union(
        v.literal("interested"),
        v.literal("needs_more_info"),
        v.literal("price_objection"),
        v.literal("not_qualified"),
        v.literal("ready_to_buy"),
      ),
    ),
  },
  handler: async (ctx, { meetingId, meetingOutcome }) => {
    console.log("[Closer:MeetingActions] updateMeetingOutcome called", {
      meetingId,
      meetingOutcome,
    });
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const { opportunity } = await loadMeetingContext(ctx, meetingId, tenantId);

    // Closer authorization: only own meetings
    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    await ctx.db.patch(meetingId, { meetingOutcome });
    console.log("[Closer:MeetingActions] meetingOutcome updated", {
      meetingId,
      meetingOutcome,
    });
  },
});
