import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import {
  assertCanRecordLegacyMeetingOutcome,
  assertCanRecordMeetingOutcome,
} from "../lib/outcomeEligibility";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import { requireTenantUser } from "../requireTenantUser";
import { validateTransition } from "../lib/statusTransitions";
import { emitDomainEvent } from "../lib/domainEvents";
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
 * Temporary defensive stub for stale clients during the Phase 2/3 deploy
 * window. Joining is now a plain link and must not mutate Convex state.
 */
export const startMeeting = mutation({
  args: { meetingId: v.id("meetings") },
  handler: async (): Promise<{
    meetingJoinUrl: string | null;
    lateStartDurationMs: number;
  }> => {
    throw new Error(
      "Start Meeting has been removed. Use Join Meeting and record the outcome directly.",
    );
  },
});

export const stopMeeting = mutation({
  args: { meetingId: v.id("meetings") },
  handler: async (): Promise<{
    exceededScheduledDurationMs: number;
    exceededScheduledDuration: boolean;
  }> => {
    throw new Error(
      "End Meeting has been removed. Record the meeting outcome directly.",
    );
  },
});

/**
 * OUTCOME MUTATION CONTRACT
 *
 * Meeting-driven outcome mutations update the opportunity and close the
 * meeting through completeMeetingForOutcome. Side-deal paths without a meeting
 * id remain opportunity-only.
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
    meetingId: v.optional(v.id("meetings")),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { opportunityId, meetingId, reason }) => {
    console.log("[Closer:Meeting] markAsLost called", { opportunityId });
    const { userId, tenantId, role } = await requireTenantUser(ctx, ["closer"]);
    console.log("[Closer:Meeting] markAsLost auth check passed", { userId });

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }

    const meeting = meetingId ? await ctx.db.get(meetingId) : null;
    if (
      meetingId &&
      (!meeting ||
        meeting.tenantId !== tenantId ||
        meeting.opportunityId !== opportunityId)
    ) {
      throw new Error("Meeting does not belong to this opportunity");
    }

    // Validate the transition
    console.log("[Closer:Meeting] markAsLost current status", { currentStatus: opportunity.status });
    const now = Date.now();
    if (meeting) {
      const handledAsLegacy = assertCanRecordLegacyMeetingOutcome({
        meeting,
        opportunity,
        userId,
        role,
      });
      if (!handledAsLegacy) {
        assertCanRecordMeetingOutcome({
          meeting,
          opportunity,
          userId,
          role,
          now,
        });
      }
    }
    if (!validateTransition(opportunity.status, "lost")) {
      throw new Error(`Cannot mark as lost from status "${opportunity.status}"`);
    }

    const normalizedReason = reason?.trim();
    const patch: Partial<Doc<"opportunities">> = {
      status: "lost",
      updatedAt: now,
      lostAt: now,
      lostByUserId: userId,
    };
    if (normalizedReason) {
      patch.lostReason = normalizedReason;
    }

    await patchOpportunityLifecycle(ctx, opportunityId, patch);
    if (meeting) {
      await completeMeetingForOutcome(ctx, {
        meeting,
        opportunity,
        toMeetingStatus: "completed",
        completedAt: now,
      });
    }
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
