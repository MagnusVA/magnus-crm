import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import {
  createManualReminder,
  createPaymentRecord,
} from "../lib/outcomeHelpers";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import {
  expirePendingFollowUpsForOpportunity,
  rollbackCustomerConversionIfEmpty,
} from "../lib/paymentHelpers";
import {
  validateMeetingTransition,
  validateTransition,
} from "../lib/statusTransitions";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "../lib/tenantStatsHelper";
import { requireTenantUser } from "../requireTenantUser";
import {
  replaceMeetingAggregate,
  replaceOpportunityAggregate,
  replacePaymentAggregate,
} from "../reporting/writeHooks";
import { loadActiveFollowUpDoc } from "../lib/activeFollowUp";
import { validateManualTimes } from "../lib/manualMeetingTimes";

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function getActiveOpportunityDelta(
  fromStatus: Doc<"opportunities">["status"],
  toStatus: Doc<"opportunities">["status"],
) {
  const fromActive = isActiveOpportunityStatus(fromStatus);
  const toActive = isActiveOpportunityStatus(toStatus);
  if (fromActive === toActive) {
    return 0;
  }
  return toActive ? 1 : -1;
}

export const resolveReview = mutation({
  args: {
    reviewId: v.id("meetingReviews"),
    resolutionAction: v.union(
      v.literal("log_payment"),
      v.literal("schedule_follow_up"),
      v.literal("mark_no_show"),
      v.literal("mark_lost"),
      v.literal("acknowledged"),
      v.literal("disputed"),
    ),
    resolutionNote: v.optional(v.string()),
    paymentData: v.optional(
      v.object({
        amount: v.number(),
        currency: v.string(),
        provider: v.string(),
        referenceCode: v.optional(v.string()),
        proofFileId: v.optional(v.id("_storage")),
      }),
    ),
    lostReason: v.optional(v.string()),
    noShowReason: v.optional(
      v.union(
        v.literal("no_response"),
        v.literal("late_cancel"),
        v.literal("technical_issues"),
        v.literal("other"),
      ),
    ),
    manualStartedAt: v.optional(v.number()),
    manualStoppedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    console.log("[Review] resolveReview called", {
      reviewId: args.reviewId,
      resolutionAction: args.resolutionAction,
    });

    const { userId, tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const review = await ctx.db.get(args.reviewId);
    if (!review || review.tenantId !== tenantId) {
      throw new Error("Review not found");
    }
    if (review.status === "resolved") {
      throw new Error("Review already resolved");
    }

    const meeting = await ctx.db.get(review.meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }

    const opportunity = await ctx.db.get(review.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    const activeFollowUp = await loadActiveFollowUpDoc(ctx, review.opportunityId);
    const closerAlreadyActed =
      opportunity.status !== "meeting_overran" || activeFollowUp !== null;
    if (
      closerAlreadyActed &&
      args.resolutionAction !== "acknowledged" &&
      args.resolutionAction !== "disputed"
    ) {
      throw new Error(
        "Direct override actions are only available before the closer has already acted.",
      );
    }

    if (args.resolutionAction === "log_payment" && !args.paymentData) {
      throw new Error("Payment data is required when logging a payment");
    }

    const now = Date.now();
    const isAcknowledged = args.resolutionAction === "acknowledged";
    const hasManualStartedAt = args.manualStartedAt !== undefined;
    const hasManualStoppedAt = args.manualStoppedAt !== undefined;
    const hasManualTimes = hasManualStartedAt && hasManualStoppedAt;

    if (hasManualStartedAt !== hasManualStoppedAt) {
      throw new Error("Manual start and end times must be provided together.");
    }

    if (isAcknowledged && !hasManualTimes) {
      throw new Error(
        "Manual start and end times are required when acknowledging a review.",
      );
    }

    if (hasManualTimes && !isAcknowledged) {
      throw new Error(
        "Manual times can only be supplied with the 'acknowledged' resolution action.",
      );
    }

    if (hasManualTimes) {
      validateManualTimes({
        scheduledAt: meeting.scheduledAt,
        manualStartedAt: args.manualStartedAt!,
        manualStoppedAt: args.manualStoppedAt!,
        now,
      });
    }

    const resolutionNote = normalizeOptionalString(args.resolutionNote);
    const lostReason = normalizeOptionalString(args.lostReason);
    const isFalsePositiveCorrection =
      review.closerResponse === "forgot_to_press";

    if (args.resolutionAction === "acknowledged") {
      const reviewPatch: Partial<Doc<"meetingReviews">> = {
        status: "resolved",
        resolvedAt: now,
        resolvedByUserId: userId,
        resolutionAction: "acknowledged",
        ...(resolutionNote ? { resolutionNote } : {}),
      };

      let manualTimesApplied = false;

      if (hasManualTimes) {
        const nextMeetingStatus =
          meeting.status === "meeting_overran" ? "completed" : meeting.status;

        if (
          nextMeetingStatus !== meeting.status &&
          !validateMeetingTransition(meeting.status, nextMeetingStatus)
        ) {
          throw new Error(
            `Cannot transition meeting from "${meeting.status}" to "${nextMeetingStatus}"`,
          );
        }

        const manualStartedAt = args.manualStartedAt!;
        const manualStoppedAt = args.manualStoppedAt!;
        const scheduledEndMs =
          meeting.scheduledAt + meeting.durationMinutes * 60_000;
        const lateStartDurationMs = Math.max(
          0,
          manualStartedAt - meeting.scheduledAt,
        );
        const exceededScheduledDurationMs = Math.max(
          0,
          manualStoppedAt - scheduledEndMs,
        );

        await ctx.db.patch(review.meetingId, {
          status: nextMeetingStatus,
          startedAt: manualStartedAt,
          startedAtSource: "admin_manual" as const,
          stoppedAt: manualStoppedAt,
          stoppedAtSource: "admin_manual" as const,
          completedAt: manualStoppedAt,
          lateStartDurationMs,
          exceededScheduledDurationMs,
        });
        await replaceMeetingAggregate(ctx, meeting, review.meetingId);
        await updateOpportunityMeetingRefs(ctx, opportunity._id);

        reviewPatch.manualStartedAt = manualStartedAt;
        reviewPatch.manualStoppedAt = manualStoppedAt;
        reviewPatch.timesSetByUserId = userId;
        reviewPatch.timesSetAt = now;

        await emitDomainEvent(ctx, {
          tenantId,
          entityType: "meeting",
          entityId: review.meetingId,
          eventType: "meeting.times_manually_set",
          source: "admin",
          actorUserId: userId,
          occurredAt: now,
          metadata: {
            reviewId: args.reviewId,
            startedAt: manualStartedAt,
            stoppedAt: manualStoppedAt,
            lateStartDurationMs,
            exceededScheduledDurationMs,
            previousMeetingStatus: meeting.status,
          },
        });

        manualTimesApplied = true;
      }

      await ctx.db.patch(args.reviewId, reviewPatch);

      await emitDomainEvent(ctx, {
        tenantId,
        entityType: "meeting",
        entityId: review.meetingId,
        eventType: "meeting.overran_review_resolved",
        source: "admin",
        actorUserId: userId,
        occurredAt: now,
        metadata: {
          reviewId: args.reviewId,
          resolutionAction: "acknowledged",
          closerResponse: review.closerResponse,
          opportunityActuallyTransitioned: false,
          manualTimesApplied,
        },
      });

      console.log("[Review] acknowledged", {
        reviewId: args.reviewId,
        manualTimesApplied,
      });
      return;
    }

    if (args.resolutionAction === "disputed") {
      const previousOpportunityStatus = opportunity.status;
      const previousMeetingStatus = meeting.status;
      let paymentDisputed = false;
      let customerConversionRolledBack = false;
      let disputedPaymentAmountMinor = 0;
      let disputedPaymentCustomerId: Id<"customers"> | null = null;

      if (previousOpportunityStatus === "payment_received") {
        const payments = await ctx.db
          .query("paymentRecords")
          .withIndex("by_opportunityId", (q) =>
            q.eq("opportunityId", review.opportunityId),
          )
          .take(50);

        const targetPayment =
          payments
            .filter(
              (payment) =>
                payment.status !== "disputed" &&
                payment.meetingId === review.meetingId,
            )
            .sort((a, b) => b.recordedAt - a.recordedAt)[0] ?? null;

        if (!targetPayment) {
          throw new Error("Recorded payment not found for disputed review");
        }

        disputedPaymentAmountMinor = targetPayment.amountMinor;
        disputedPaymentCustomerId = targetPayment.customerId ?? null;
        await ctx.db.patch(targetPayment._id, {
          status: "disputed",
          statusChangedAt: now,
        });
        await replacePaymentAggregate(ctx, targetPayment, targetPayment._id);
        paymentDisputed = true;

        await emitDomainEvent(ctx, {
          tenantId,
          entityType: "payment",
          entityId: targetPayment._id,
          eventType: "payment.disputed",
          source: "admin",
          actorUserId: userId,
          fromStatus: targetPayment.status,
          toStatus: "disputed",
          reason: "review_disputed",
          metadata: {
            reviewId: args.reviewId,
            opportunityId: review.opportunityId,
            meetingId: review.meetingId,
            amountMinor: targetPayment.amountMinor,
            currency: targetPayment.currency,
          },
          occurredAt: now,
        });
      }

      if (previousOpportunityStatus !== "meeting_overran") {
        await ctx.db.patch(opportunity._id, {
          status: "meeting_overran",
          updatedAt: now,
          ...(previousOpportunityStatus === "payment_received"
            ? { paymentReceivedAt: undefined }
            : {}),
          ...(previousOpportunityStatus === "lost"
            ? {
                lostAt: undefined,
                lostByUserId: undefined,
                lostReason: undefined,
              }
            : {}),
          ...(previousOpportunityStatus === "no_show"
            ? { noShowAt: undefined }
            : {}),
        });
        await replaceOpportunityAggregate(ctx, opportunity, opportunity._id);
      }

      if (previousMeetingStatus === "no_show") {
        await ctx.db.patch(meeting._id, {
          status: "meeting_overran",
          noShowMarkedAt: undefined,
          noShowWaitDurationMs: undefined,
          noShowReason: undefined,
          noShowNote: undefined,
          noShowMarkedByUserId: undefined,
          noShowSource: undefined,
        });
        await replaceMeetingAggregate(ctx, meeting, meeting._id);
      }

      await expirePendingFollowUpsForOpportunity(ctx, opportunity._id, userId);

      const activeDelta = getActiveOpportunityDelta(
        previousOpportunityStatus,
        "meeting_overran",
      );
      const statsDelta = {
        ...(activeDelta !== 0 ? { activeOpportunities: activeDelta } : {}),
        ...(previousOpportunityStatus === "lost" ? { lostDeals: -1 } : {}),
        ...(previousOpportunityStatus === "payment_received"
          ? {
              wonDeals: -1,
              totalPaymentRecords: -1,
              totalRevenueMinor: -disputedPaymentAmountMinor,
            }
          : {}),
      };
      if (Object.keys(statsDelta).length > 0) {
        await updateTenantStats(ctx, tenantId, statsDelta);
      }

      if (paymentDisputed && disputedPaymentCustomerId) {
        const rollbackResult = await rollbackCustomerConversionIfEmpty(ctx, {
          customerId: disputedPaymentCustomerId,
          opportunityId: opportunity._id,
          actorUserId: userId,
        });
        customerConversionRolledBack = rollbackResult.rolledBack;
      }

      await ctx.db.patch(args.reviewId, {
        status: "resolved",
        resolvedAt: now,
        resolvedByUserId: userId,
        resolutionAction: "disputed",
        ...(resolutionNote ? { resolutionNote } : {}),
      });

      if (
        previousOpportunityStatus !== "meeting_overran" ||
        previousMeetingStatus === "no_show"
      ) {
        await updateOpportunityMeetingRefs(ctx, opportunity._id);
      }

      if (previousOpportunityStatus !== "meeting_overran") {
        await emitDomainEvent(ctx, {
          tenantId,
          entityType: "opportunity",
          entityId: opportunity._id,
          eventType: "opportunity.status_changed",
          source: "admin",
          actorUserId: userId,
          fromStatus: previousOpportunityStatus,
          toStatus: "meeting_overran",
          reason: "review_disputed",
          occurredAt: now,
        });
      }

      if (previousMeetingStatus === "no_show") {
        await emitDomainEvent(ctx, {
          tenantId,
          entityType: "meeting",
          entityId: meeting._id,
          eventType: "meeting.status_changed",
          source: "admin",
          actorUserId: userId,
          fromStatus: previousMeetingStatus,
          toStatus: "meeting_overran",
          reason: "review_disputed",
          occurredAt: now,
        });
      }

      await emitDomainEvent(ctx, {
        tenantId,
        entityType: "meeting",
        entityId: review.meetingId,
        eventType: "meeting.overran_review_resolved",
        source: "admin",
        actorUserId: userId,
        occurredAt: now,
        metadata: {
          reviewId: args.reviewId,
          resolutionAction: "disputed",
          previousOpportunityStatus,
          previousMeetingStatus,
          paymentDisputed,
          customerConversionRolledBack,
          closerAlreadyActed,
          activeFollowUpId: activeFollowUp?._id ?? null,
        },
      });

      console.log("[Review] disputed", {
        reviewId: args.reviewId,
        previousOpportunityStatus,
        previousMeetingStatus,
        paymentDisputed,
        customerConversionRolledBack,
      });
      return;
    }

    let targetOpportunityStatus: Doc<"opportunities">["status"] | null = null;
    switch (args.resolutionAction) {
      case "log_payment":
        targetOpportunityStatus = "payment_received";
        break;
      case "mark_no_show":
        targetOpportunityStatus = "no_show";
        break;
      case "mark_lost":
        targetOpportunityStatus = "lost";
        break;
      case "schedule_follow_up":
        break;
      default:
        break;
    }

    const opportunityActuallyTransitioned = targetOpportunityStatus !== null;
    if (
      targetOpportunityStatus &&
      !validateTransition(opportunity.status, targetOpportunityStatus)
    ) {
      throw new Error(
        `Cannot transition from "${opportunity.status}" to "${targetOpportunityStatus}"`,
      );
    }

    if (targetOpportunityStatus) {
      await ctx.db.patch(opportunity._id, {
        status: targetOpportunityStatus,
        updatedAt: now,
        ...(args.resolutionAction === "log_payment"
          ? { paymentReceivedAt: now }
          : {}),
        ...(args.resolutionAction === "mark_lost"
          ? {
              lostAt: now,
              lostByUserId: userId,
              ...(lostReason ? { lostReason } : {}),
            }
          : {}),
        ...(args.resolutionAction === "mark_no_show" ? { noShowAt: now } : {}),
      });
      await replaceOpportunityAggregate(ctx, opportunity, opportunity._id);
    }

    const falsePositiveCorrected =
      isFalsePositiveCorrection && meeting.status === "meeting_overran";
    if (falsePositiveCorrected) {
      if (!validateMeetingTransition(meeting.status, "completed")) {
        throw new Error(
          `Cannot transition meeting from "${meeting.status}" to "completed"`,
        );
      }
      await ctx.db.patch(review.meetingId, {
        status: "completed",
        completedAt: now,
      });
      await replaceMeetingAggregate(ctx, meeting, review.meetingId);
    }

    if (args.resolutionAction === "log_payment" && args.paymentData) {
      await createPaymentRecord(ctx, {
        tenantId,
        opportunityId: review.opportunityId,
        meetingId: review.meetingId,
        actorUserId: userId,
        amount: args.paymentData.amount,
        currency: args.paymentData.currency,
        provider: args.paymentData.provider,
        referenceCode: args.paymentData.referenceCode,
        proofFileId: args.paymentData.proofFileId,
        origin: "admin_meeting",
        loggedByAdminUserId: userId,
      });
    } else if (args.resolutionAction === "schedule_follow_up") {
      await createManualReminder(ctx, {
        tenantId,
        opportunityId: review.opportunityId,
        actorUserId: userId,
        note: resolutionNote ?? "Scheduled via meeting-overran review resolution",
        reason: "overran_review_resolution",
        createdByUserId: userId,
        createdSource: "admin",
      });
    }

    await ctx.db.patch(args.reviewId, {
      status: "resolved",
      resolvedAt: now,
      resolvedByUserId: userId,
      resolutionAction: args.resolutionAction,
      ...(resolutionNote ? { resolutionNote } : {}),
    });

    if (targetOpportunityStatus || falsePositiveCorrected) {
      await updateOpportunityMeetingRefs(ctx, opportunity._id);
    }

    if (targetOpportunityStatus) {
      const activeDelta = getActiveOpportunityDelta(
        opportunity.status,
        targetOpportunityStatus,
      );
      const statsDelta = {
        ...(activeDelta !== 0 ? { activeOpportunities: activeDelta } : {}),
        ...(args.resolutionAction === "mark_lost" ? { lostDeals: 1 } : {}),
      };
      if (Object.keys(statsDelta).length > 0) {
        await updateTenantStats(ctx, tenantId, statsDelta);
      }

      await emitDomainEvent(ctx, {
        tenantId,
        entityType: "opportunity",
        entityId: opportunity._id,
        eventType: "opportunity.status_changed",
        source: "admin",
        actorUserId: userId,
        fromStatus: opportunity.status,
        toStatus: targetOpportunityStatus,
        occurredAt: now,
        metadata: {
          reviewId: args.reviewId,
          resolutionAction: args.resolutionAction,
          noShowReason: args.noShowReason,
        },
      });
    }

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "meeting",
      entityId: review.meetingId,
      eventType: "meeting.overran_review_resolved",
      source: "admin",
      actorUserId: userId,
      occurredAt: now,
      metadata: {
        reviewId: args.reviewId,
        resolutionAction: args.resolutionAction,
        closerResponse: review.closerResponse,
        targetOpportunityStatus:
          targetOpportunityStatus ?? opportunity.status,
        opportunityActuallyTransitioned,
        falsePositiveCorrected,
      },
    });

    console.log("[Review] resolved", {
      reviewId: args.reviewId,
      action: args.resolutionAction,
      opportunityTransitioned: opportunityActuallyTransitioned,
      falsePositiveCorrected,
    });
  },
});
