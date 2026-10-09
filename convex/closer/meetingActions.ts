import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { assertCanRecordMeetingOutcome } from "../lib/outcomeEligibility";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import { requireTenantUser } from "../requireTenantUser";
import { validateTransition } from "../lib/statusTransitions";
import { emitDomainEvent } from "../lib/domainEvents";
import { log } from "../lib/observability/log";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "../lib/tenantStatsHelper";

export async function loadMeetingContext(
  ctx: MutationCtx,
  meetingId: Id<"meetings">,
  tenantId: Id<"tenants">,
) {
  const meeting = await ctx.db.get("meetings", meetingId);
  if (!meeting || meeting.tenantId !== tenantId) {
    throw new Error("Meeting not found");
  }

  const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Opportunity not found");
  }

  return { meeting, opportunity };
}

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
    const { userId, tenantId, role } = await requireTenantUser(ctx, ["closer"]);

    const opportunity = await ctx.db.get("opportunities", opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }

    const meeting = meetingId ? await ctx.db.get("meetings", meetingId) : null;
    if (
      meetingId &&
      (!meeting ||
        meeting.tenantId !== tenantId ||
        meeting.opportunityId !== opportunityId)
    ) {
      throw new Error("Meeting does not belong to this opportunity");
    }

    // Validate the transition
    const now = Date.now();
    if (meeting) {
      assertCanRecordMeetingOutcome({
        meeting,
        opportunity,
        userId,
        role,
        now,
      });
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
        meetingId: meeting._id,
        opportunityId: opportunity._id,
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
  },
});

export const saveFathomLink = mutation({
  args: {
    meetingId: v.id("meetings"),
    fathomLink: v.string(),
  },
  handler: async (ctx, { meetingId, fathomLink: rawLink }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const { meeting, opportunity } = await loadMeetingContext(
      ctx,
      meetingId,
      tenantId,
    );

    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    const fathomLink = rawLink.trim();
    if (!fathomLink) {
      throw new Error("Fathom link is required");
    }

    const now = Date.now();
    await ctx.db.patch("meetings", meetingId, {
      fathomLink,
      fathomLinkSavedAt: now,
    });

    log.info("meeting.fathom_link_saved", {
      tenantId,
      actor: role === "closer" ? "closer" : "admin",
      meetingId,
      opportunityId: opportunity._id,
      replacedExisting: Boolean(meeting.fathomLink),
    });
  },
});
