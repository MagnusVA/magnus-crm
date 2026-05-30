import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import {
  assertCanRecordLegacyMeetingOutcome,
  assertCanRecordMeetingOutcome,
} from "../lib/outcomeEligibility";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import { validateTransition } from "../lib/statusTransitions";
import { requireTenantUser } from "../requireTenantUser";
import { emitDomainEvent } from "../lib/domainEvents";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "../lib/tenantStatsHelper";

const noShowReasonValidator = v.union(
  v.literal("no_response"),
  v.literal("late_cancel"),
  v.literal("technical_issues"),
  v.literal("other"),
);

function normalizeOptionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Mark a scheduled meeting as no-show.
 *
 * Records structured no-show metadata and transitions both the meeting and
 * opportunity to "no_show" without writing actual meeting timing fields.
 */
export const markNoShow = mutation({
  args: {
    meetingId: v.id("meetings"),
    reason: noShowReasonValidator,
    note: v.optional(v.string()),
  },
  handler: async (ctx, { meetingId, reason, note }) => {
    console.log("[Closer:NoShow] markNoShow called", { meetingId, reason });
    const { userId, tenantId, role } = await requireTenantUser(ctx, ["closer"]);

    const meeting = await ctx.db.get(meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    const now = Date.now();
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
    if (!validateTransition(opportunity.status, "no_show")) {
      throw new Error(
        `Cannot transition opportunity from "${opportunity.status}" to "no_show"`,
      );
    }

    const normalizedNote = normalizeOptionalString(note);

    await patchOpportunityLifecycle(ctx, opportunity._id, {
      status: "no_show",
      noShowAt: now,
      updatedAt: now,
    });
    await completeMeetingForOutcome(ctx, {
      meeting,
      opportunity,
      toMeetingStatus: "no_show",
      completedAt: now,
      extraMeetingPatch: {
        noShowMarkedAt: now,
        noShowReason: reason,
        noShowNote: normalizedNote,
        noShowMarkedByUserId: userId,
        noShowSource: "closer",
      },
    });

    await updateTenantStats(ctx, tenantId, {
      activeOpportunities: isActiveOpportunityStatus(opportunity.status) ? -1 : 0,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "meeting",
      entityId: meetingId,
      eventType: "meeting.no_show",
      source: "closer",
      actorUserId: userId,
      fromStatus: meeting.status,
      toStatus: "no_show",
      reason,
      metadata: {
        note: normalizedNote,
      },
      occurredAt: now,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunity._id,
      eventType: "opportunity.status_changed",
      source: "closer",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "no_show",
      reason,
      occurredAt: now,
    });

    console.log("[Closer:NoShow] markNoShow completed", {
      meetingId,
      opportunityId: opportunity._id,
      closerId: userId,
      reason,
      noShowMarkedAt: now,
    });
  },
});

/**
 * Generate a reschedule link for a no-show opportunity.
 *
 * Creates a pending scheduling-link follow-up with no-show-specific UTMs and
 * transitions the opportunity to "reschedule_link_sent" so the pipeline can
 * deterministically relink the lead's next booking.
 */
export const createNoShowRescheduleLink = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, { opportunityId, meetingId }) => {
    console.log("[Closer:NoShow] createNoShowRescheduleLink called", {
      opportunityId,
      meetingId,
    });
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }
    if (!user.personalEventTypeUri) {
      throw new Error(
        "No personal calendar configured. Ask your admin to assign one in Team settings.",
      );
    }

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }
    if (opportunity.status !== "no_show") {
      throw new Error(
        `Reschedule is only available for no-show opportunities (current: "${opportunity.status}")`,
      );
    }
    if (!validateTransition(opportunity.status, "reschedule_link_sent")) {
      throw new Error(
        `Cannot transition opportunity from "${opportunity.status}" to "reschedule_link_sent"`,
      );
    }

    const meeting = await ctx.db.get(meetingId);
    if (
      !meeting ||
      meeting.tenantId !== tenantId ||
      meeting.opportunityId !== opportunityId
    ) {
      throw new Error("Meeting not found or does not belong to this opportunity");
    }
    if (meeting.status !== "no_show") {
      throw new Error(
        `Reschedule link can only be created from a no-show meeting (current: "${meeting.status}")`,
      );
    }

    let schedulingLinkUrl: string;
    try {
      const bookingUrl = new URL(user.personalEventTypeUri);
      bookingUrl.searchParams.set("utm_source", "ptdom");
      bookingUrl.searchParams.set("utm_medium", "noshow_resched");
      bookingUrl.searchParams.set("utm_campaign", opportunityId);
      bookingUrl.searchParams.set("utm_content", meetingId);
      bookingUrl.searchParams.set("utm_term", userId);
      schedulingLinkUrl = bookingUrl.toString();
    } catch {
      throw new Error("Personal calendar URL is invalid");
    }

    const now = Date.now();
    const followUpId = await ctx.db.insert("followUps", {
      tenantId,
      opportunityId,
      leadId: opportunity.leadId,
      closerId: userId,
      type: "scheduling_link",
      schedulingLinkUrl,
      reason: "no_show_follow_up",
      status: "pending",
      createdAt: now,
      createdByUserId: userId,
      createdSource: "closer",
    });

    await patchOpportunityLifecycle(ctx, opportunityId, {
      status: "reschedule_link_sent",
      updatedAt: now,
    });
    await updateTenantStats(ctx, tenantId, {
      activeOpportunities: isActiveOpportunityStatus(opportunity.status) ? 0 : 1,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: followUpId,
      eventType: "followUp.created",
      source: "closer",
      actorUserId: userId,
      toStatus: "pending",
      metadata: {
        type: "scheduling_link",
        opportunityId,
      },
      occurredAt: now,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.status_changed",
      source: "closer",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "reschedule_link_sent",
      occurredAt: now,
    });

    console.log("[Closer:NoShow] createNoShowRescheduleLink completed", {
      followUpId,
      opportunityId,
      originalMeetingId: meetingId,
    });

    return { schedulingLinkUrl, followUpId };
  },
});
