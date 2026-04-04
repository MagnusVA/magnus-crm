import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { requireTenantUser } from "../requireTenantUser";
import { validateTransition } from "../lib/statusTransitions";

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
 * Returns the Zoom join URL so the frontend can open it in a new tab.
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

    console.log("[Closer:Meeting] startMeeting transitioning to in_progress", { meetingId, opportunityId: opportunity._id });
    await ctx.db.patch(opportunity._id, {
      status: "in_progress",
      updatedAt: Date.now(),
    });

    await ctx.db.patch(meetingId, { status: "in_progress" });
    await updateOpportunityMeetingRefs(ctx, opportunity._id);

    console.log("[Closer:Meeting] startMeeting completed", { hasZoomUrl: !!meeting.zoomJoinUrl });
    return { zoomJoinUrl: meeting.zoomJoinUrl ?? null };
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
    const patch: Partial<Doc<"opportunities">> = {
      status: "lost",
      updatedAt: Date.now(),
    };
    if (normalizedReason) {
      patch.lostReason = normalizedReason;
    }

    await ctx.db.patch(opportunityId, patch);
    console.log("[Closer:Meeting] markAsLost patch applied", { opportunityId, newStatus: "lost", hasReason: !!normalizedReason });
  },
});
