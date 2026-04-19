import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, mutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { validateTransition } from "../lib/statusTransitions";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "../lib/tenantStatsHelper";
import { requireTenantUser } from "../requireTenantUser";
import {
  replaceMeetingAggregate,
  replaceOpportunityAggregate,
} from "../reporting/writeHooks";

const closerResponseValidator = v.union(
  v.literal("forgot_to_press"),
  v.literal("did_not_attend"),
);

const closerStatedOutcomeValidator = v.union(
  v.literal("sale_made"),
  v.literal("follow_up_needed"),
  v.literal("lead_not_interested"),
  v.literal("lead_no_show"),
  v.literal("other"),
);

function normalizeRequiredText(value: string, errorMessage: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(errorMessage);
  }
  return trimmed;
}

function getActiveOpportunityDelta(
  fromStatus: Doc<"opportunities">["status"],
  toStatus: Doc<"opportunities">["status"],
): number {
  const fromActive = isActiveOpportunityStatus(fromStatus);
  const toActive = isActiveOpportunityStatus(toStatus);
  if (fromActive === toActive) {
    return 0;
  }
  return toActive ? 1 : -1;
}

export const checkMeetingAttendance = internalMutation({
  args: { meetingId: v.id("meetings") },
  handler: async (ctx, { meetingId }) => {
    const meeting = await ctx.db.get(meetingId);
    if (!meeting) {
      console.warn("[MeetingOverrun] Meeting not found; skipping attendance check", {
        meetingId,
      });
      return;
    }

    if (meeting.status !== "scheduled") {
      console.log("[MeetingOverrun] Attendance check no-op; meeting already handled", {
        meetingId,
        meetingStatus: meeting.status,
      });
      return;
    }

    if (meeting.reviewId) {
      console.log("[MeetingOverrun] Attendance check no-op; review already linked", {
        meetingId,
        reviewId: meeting.reviewId,
      });
      return;
    }

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (!opportunity || opportunity.tenantId !== meeting.tenantId) {
      console.error("[MeetingOverrun] Opportunity missing for attendance check", {
        meetingId,
        opportunityId: meeting.opportunityId,
      });
      return;
    }

    const shouldTransitionOpportunity = opportunity.status === "scheduled";
    const now = Date.now();

    const reviewId = await ctx.db.insert("meetingReviews", {
      tenantId: meeting.tenantId,
      meetingId,
      opportunityId: opportunity._id,
      closerId: meeting.assignedCloserId,
      category: "meeting_overran",
      status: "pending",
      createdAt: now,
    });

    await ctx.db.patch(meetingId, {
      status: "meeting_overran",
      overranDetectedAt: now,
      reviewId,
    });
    await replaceMeetingAggregate(ctx, meeting, meetingId);

    if (shouldTransitionOpportunity) {
      await ctx.db.patch(opportunity._id, {
        status: "meeting_overran",
        updatedAt: now,
      });
      await replaceOpportunityAggregate(ctx, opportunity, opportunity._id);
    }

    await updateOpportunityMeetingRefs(ctx, opportunity._id);

    await emitDomainEvent(ctx, {
      tenantId: meeting.tenantId,
      entityType: "meeting",
      entityId: meetingId,
      eventType: "meeting.overran_detected",
      source: "system",
      occurredAt: now,
      metadata: {
        reviewId,
        scheduledAt: meeting.scheduledAt,
        durationMinutes: meeting.durationMinutes,
        attendanceCheckId: meeting.attendanceCheckId,
        opportunityStatusBeforeCheck: opportunity.status,
      },
    });

    if (shouldTransitionOpportunity) {
      await emitDomainEvent(ctx, {
        tenantId: meeting.tenantId,
        entityType: "opportunity",
        entityId: opportunity._id,
        eventType: "opportunity.status_changed",
        source: "system",
        fromStatus: "scheduled",
        toStatus: "meeting_overran",
        occurredAt: now,
        metadata: {
          reviewId,
          trigger: "attendance_check",
          meetingId,
        },
      });
    }

    console.log("[MeetingOverrun] Meeting flagged after unattended attendance check", {
      meetingId,
      reviewId,
      opportunityId: opportunity._id,
      opportunityTransitioned: shouldTransitionOpportunity,
    });
  },
});

export const respondToOverranReview = mutation({
  args: {
    reviewId: v.id("meetingReviews"),
    closerResponse: closerResponseValidator,
    closerNote: v.string(),
    closerStatedOutcome: v.optional(closerStatedOutcomeValidator),
    estimatedMeetingDurationMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const review = await ctx.db.get(args.reviewId);
    if (!review || review.tenantId !== tenantId) {
      throw new Error("Review not found");
    }
    if (review.category !== "meeting_overran") {
      throw new Error("Review category is not supported");
    }
    if (review.closerId !== userId) {
      throw new Error("Not your review");
    }
    if (review.status === "resolved") {
      throw new Error("Review already resolved");
    }
    if (review.closerResponse) {
      throw new Error("You have already responded to this review");
    }

    const closerNote = normalizeRequiredText(
      args.closerNote,
      "A note describing what happened is required",
    );

    if (args.closerResponse === "forgot_to_press") {
      if (!args.closerStatedOutcome) {
        throw new Error(
          "Stated outcome is required when claiming you forgot to press start",
        );
      }
      if (
        !args.estimatedMeetingDurationMinutes ||
        args.estimatedMeetingDurationMinutes < 1 ||
        args.estimatedMeetingDurationMinutes > 480
      ) {
        throw new Error(
          "Estimated meeting duration must be between 1 and 480 minutes",
        );
      }
    }

    const now = Date.now();
    await ctx.db.patch(args.reviewId, {
      closerResponse: args.closerResponse,
      closerNote,
      closerRespondedAt: now,
      ...(args.closerResponse === "forgot_to_press"
        ? {
            closerStatedOutcome: args.closerStatedOutcome,
            estimatedMeetingDurationMinutes:
              args.estimatedMeetingDurationMinutes,
          }
        : {}),
    });

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "meeting",
      entityId: review.meetingId,
      eventType: "meeting.overran_closer_responded",
      source: "closer",
      actorUserId: userId,
      occurredAt: now,
      metadata: {
        reviewId: args.reviewId,
        closerResponse: args.closerResponse,
        closerStatedOutcome:
          args.closerResponse === "forgot_to_press"
            ? args.closerStatedOutcome
            : undefined,
      },
    });

    console.log("[MeetingOverrun] Closer responded to overran review", {
      reviewId: args.reviewId,
      closerResponse: args.closerResponse,
    });

    return { success: true };
  },
});

export const scheduleFollowUpFromOverran = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    note: v.string(),
  },
  handler: async (ctx, { opportunityId, note }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);
    const reminderNote = normalizeRequiredText(
      note,
      "A note describing the follow-up plan is required",
    );

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }
    if (opportunity.status !== "meeting_overran") {
      throw new Error(
        `Expected opportunity status "meeting_overran", got "${opportunity.status}"`,
      );
    }
    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(
        `Cannot schedule follow-up from status "${opportunity.status}"`,
      );
    }

    const now = Date.now();
    await ctx.db.patch(opportunityId, {
      status: "follow_up_scheduled",
      updatedAt: now,
    });
    await replaceOpportunityAggregate(ctx, opportunity, opportunityId);

    const followUpId = await ctx.db.insert("followUps", {
      tenantId,
      opportunityId,
      leadId: opportunity.leadId,
      closerId: userId,
      type: "manual_reminder",
      reminderNote,
      reason: "closer_initiated",
      status: "pending",
      createdAt: now,
      createdByUserId: userId,
      createdSource: "closer",
    });

    const activeDelta = getActiveOpportunityDelta(
      opportunity.status,
      "follow_up_scheduled",
    );
    if (activeDelta !== 0) {
      await updateTenantStats(ctx, tenantId, {
        activeOpportunities: activeDelta,
      });
    }

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: followUpId,
      eventType: "followUp.created",
      source: "closer",
      actorUserId: userId,
      toStatus: "pending",
      occurredAt: now,
      metadata: {
        opportunityId,
        type: "manual_reminder",
        createdVia: "meeting_overran_follow_up",
      },
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.status_changed",
      source: "closer",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "follow_up_scheduled",
      occurredAt: now,
      metadata: {
        reason: "follow_up_after_meeting_overran",
        followUpId,
      },
    });

    console.log("[MeetingOverrun] Follow-up scheduled from meeting_overran", {
      opportunityId,
      followUpId,
    });

    return { success: true, followUpId };
  },
});
