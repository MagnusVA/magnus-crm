import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { assertValidDateRange, getUserDisplayName } from "./lib/helpers";

const REPORT_ROW_CAP = 2000;
const MAX_PENDING_SCAN_ROWS = REPORT_ROW_CAP + 1;
const MAX_RESOLVED_SCAN_ROWS = REPORT_ROW_CAP + 1;
const MAX_DISPUTED_PAYMENT_SCAN_ROWS = REPORT_ROW_CAP + 1;

type ResolutionAction =
  | "log_payment"
  | "schedule_follow_up"
  | "mark_no_show"
  | "mark_lost"
  | "acknowledged"
  | "disputed";

type CloserResponse = "forgot_to_press" | "did_not_attend" | "no_response";

function emptyResolutionMix(): Record<ResolutionAction, number> {
  return {
    log_payment: 0,
    schedule_follow_up: 0,
    mark_no_show: 0,
    mark_lost: 0,
    acknowledged: 0,
    disputed: 0,
  };
}

function emptyCloserResponseMix(): Record<CloserResponse, number> {
  return {
    forgot_to_press: 0,
    did_not_attend: 0,
    no_response: 0,
  };
}

export const getReviewReportingMetrics = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    assertValidDateRange(startDate, endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const pendingReviews = await ctx.db
      .query("meetingReviews")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "pending"),
      )
      .take(MAX_PENDING_SCAN_ROWS);

    const backlog = {
      pendingCount: Math.min(pendingReviews.length, REPORT_ROW_CAP),
      isTruncated: pendingReviews.length > REPORT_ROW_CAP,
      measuredAt: Date.now(),
    };

    const resolvedReviewWindow = await ctx.db
      .query("meetingReviews")
      .withIndex("by_tenantId_and_resolvedAt", (q) =>
        q.eq("tenantId", tenantId).gte("resolvedAt", startDate).lt("resolvedAt", endDate),
      )
      .take(MAX_RESOLVED_SCAN_ROWS);

    const isResolvedRangeTruncated = resolvedReviewWindow.length > REPORT_ROW_CAP;
    const resolvedReviews = resolvedReviewWindow.slice(0, REPORT_ROW_CAP);

    const resolutionMix = emptyResolutionMix();
    const closerResponseMix = emptyCloserResponseMix();
    const reviewerStats = new Map<
      Id<"users">,
      { resolved: number; totalLatencyMs: number }
    >();

    let unclassifiedResolved = 0;
    let manualTimeCorrectionCount = 0;
    let totalResolveLatencyMs = 0;
    let latencySampleCount = 0;

    for (const review of resolvedReviews) {
      if (review.resolutionAction) {
        resolutionMix[review.resolutionAction] += 1;
      } else {
        unclassifiedResolved += 1;
      }

      if (review.timesSetByUserId) {
        manualTimeCorrectionCount += 1;
      }

      if (review.closerResponse) {
        closerResponseMix[review.closerResponse] += 1;
      } else {
        closerResponseMix.no_response += 1;
      }

      if (review.resolvedAt !== undefined) {
        const latencyMs = review.resolvedAt - review.createdAt;
        totalResolveLatencyMs += latencyMs;
        latencySampleCount += 1;

        if (review.resolvedByUserId) {
          const current = reviewerStats.get(review.resolvedByUserId) ?? {
            resolved: 0,
            totalLatencyMs: 0,
          };
          reviewerStats.set(review.resolvedByUserId, {
            resolved: current.resolved + 1,
            totalLatencyMs: current.totalLatencyMs + latencyMs,
          });
        }
      }
    }

    const reviewerEntries = await Promise.all(
      Array.from(reviewerStats.entries()).map(async ([userId, stats]) => {
        const reviewer = await ctx.db.get(userId);
        return {
          userId,
          reviewerName: reviewer ? getUserDisplayName(reviewer) : "Unknown admin",
          resolved: stats.resolved,
          avgLatencyMs:
            stats.resolved > 0 ? stats.totalLatencyMs / stats.resolved : null,
        };
      }),
    );

    reviewerEntries.sort(
      (left, right) =>
        right.resolved - left.resolved ||
        left.reviewerName.localeCompare(right.reviewerName),
    );

    const disputedPaymentWindow = await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_status_and_recordedAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("status", "disputed")
          .gte("recordedAt", startDate)
          .lt("recordedAt", endDate),
      )
      .take(MAX_DISPUTED_PAYMENT_SCAN_ROWS);

    const isDisputedRevenueTruncated =
      disputedPaymentWindow.length > REPORT_ROW_CAP;
    const disputedPayments = disputedPaymentWindow.slice(0, REPORT_ROW_CAP);
    const disputedRevenueMinor = disputedPayments.reduce(
      (sum, payment) => sum + payment.amountMinor,
      0,
    );
    const resolvedCount = resolvedReviews.length;

    return {
      backlog,
      resolvedCount,
      unclassifiedResolved,
      resolutionMix,
      manualTimeCorrectionCount,
      manualTimeCorrectionRate:
        resolvedCount > 0 ? manualTimeCorrectionCount / resolvedCount : null,
      avgResolveLatencyMs:
        latencySampleCount > 0 ? totalResolveLatencyMs / latencySampleCount : null,
      closerResponseMix,
      disputeRate:
        resolvedCount > 0 ? resolutionMix.disputed / resolvedCount : null,
      disputedRevenueMinor,
      disputedPaymentsCount: disputedPayments.length,
      isResolvedRangeTruncated,
      isDisputedRevenueTruncated,
      reviewerWorkload: reviewerEntries,
    };
  },
});
