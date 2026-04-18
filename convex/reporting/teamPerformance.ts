import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { meetingsByStatus } from "./aggregates";
import {
  attributePaymentsToClosers,
  getActiveClosers,
  getNonDisputedPaymentsInRange,
  getUserDisplayName,
  makeTupleDateBounds,
  summarizeAttributedPayments,
} from "./lib/helpers";

const CALL_CLASSIFICATIONS = ["new", "follow_up"] as const;
const MEETING_STATUSES = [
  "scheduled",
  "in_progress",
  "completed",
  "canceled",
  "no_show",
  "meeting_overran",
] as const satisfies ReadonlyArray<Doc<"meetings">["status"]>;

type CallClassification = (typeof CALL_CLASSIFICATIONS)[number];
type MeetingStatus = (typeof MEETING_STATUSES)[number];
type MeetingAggregateBounds = {
  lower: {
    inclusive: true;
    key: [Id<"users">, CallClassification, MeetingStatus, number];
  };
  upper: {
    inclusive: false;
    key: [Id<"users">, CallClassification, MeetingStatus, number];
  };
};
type StatusCountMap = Record<MeetingStatus, number>;

function emptyStatusCountMap(): StatusCountMap {
  return {
    scheduled: 0,
    in_progress: 0,
    completed: 0,
    canceled: 0,
    no_show: 0,
    meeting_overran: 0,
  };
}

function toRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export const getTeamPerformanceMetrics = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const closers = await getActiveClosers(ctx, tenantId);

    const countQueries: Array<{
      bounds: MeetingAggregateBounds;
      namespace: Id<"tenants">;
    }> = [];
    const countMeta: Array<{
      classification: CallClassification;
      closerId: Id<"users">;
      status: MeetingStatus;
    }> = [];

    for (const closer of closers) {
      for (const classification of CALL_CLASSIFICATIONS) {
        for (const status of MEETING_STATUSES) {
          countQueries.push({
            namespace: tenantId,
            bounds: makeTupleDateBounds(
              [closer._id, classification, status],
              startDate,
              endDate,
            ),
          });
          countMeta.push({
            closerId: closer._id,
            classification,
            status,
          });
        }
      }
    }

    const counts =
      countQueries.length > 0
        ? await meetingsByStatus.countBatch(ctx, countQueries)
        : [];

    const statusCountsByCloser = new Map<
      Id<"users">,
      Record<CallClassification, StatusCountMap>
    >(
      closers.map((closer) => [
        closer._id,
        {
          new: emptyStatusCountMap(),
          follow_up: emptyStatusCountMap(),
        },
      ]),
    );

    for (const [index, count] of counts.entries()) {
      const meta = countMeta[index];
      const closerCounts = statusCountsByCloser.get(meta.closerId);
      if (!closerCounts) {
        continue;
      }
      closerCounts[meta.classification][meta.status] = count;
    }

    const paymentScan = await getNonDisputedPaymentsInRange(
      ctx,
      tenantId,
      startDate,
      endDate,
    );
    const attributedPayments = await attributePaymentsToClosers(
      ctx,
      paymentScan.payments,
    );
    const paymentSummary = summarizeAttributedPayments(attributedPayments);

    const closerResults = closers.map((closer) => {
      const closerCounts = statusCountsByCloser.get(closer._id) ?? {
        new: emptyStatusCountMap(),
        follow_up: emptyStatusCountMap(),
      };
      const paymentStats = paymentSummary.byCloser.get(closer._id) ?? {
        dealCount: 0,
        revenueMinor: 0,
      };

      const buildClassificationMetrics = (classification: CallClassification) => {
        const countsForClassification = closerCounts[classification];
        const bookedCalls = MEETING_STATUSES.reduce(
          (sum, status) => sum + countsForClassification[status],
          0,
        );
        const canceledCalls = countsForClassification.canceled;
        const callsShowed =
          countsForClassification.completed + countsForClassification.in_progress;
        const showRateDenominator = bookedCalls - canceledCalls;

        return {
          bookedCalls,
          canceledCalls,
          noShows:
            countsForClassification.no_show +
            countsForClassification.meeting_overran,
          callsShowed,
          showUpRate: toRate(callsShowed, showRateDenominator),
        };
      };

      const newCalls = buildClassificationMetrics("new");
      const followUpCalls = buildClassificationMetrics("follow_up");
      const totalShowed = newCalls.callsShowed + followUpCalls.callsShowed;

      return {
        closerId: closer._id,
        closerName: getUserDisplayName(closer),
        newCalls,
        followUpCalls,
        sales: paymentStats.dealCount,
        cashCollectedMinor: paymentStats.revenueMinor,
        closeRate: toRate(paymentStats.dealCount, totalShowed),
        avgCashCollectedMinor:
          paymentStats.dealCount > 0
            ? paymentStats.revenueMinor / paymentStats.dealCount
            : null,
      };
    });

    const teamTotals = closerResults.reduce(
      (acc, closer) => ({
        newBookedCalls: acc.newBookedCalls + closer.newCalls.bookedCalls,
        newCanceled: acc.newCanceled + closer.newCalls.canceledCalls,
        newNoShows: acc.newNoShows + closer.newCalls.noShows,
        newShowed: acc.newShowed + closer.newCalls.callsShowed,
        followUpBookedCalls:
          acc.followUpBookedCalls + closer.followUpCalls.bookedCalls,
        followUpCanceled:
          acc.followUpCanceled + closer.followUpCalls.canceledCalls,
        followUpNoShows: acc.followUpNoShows + closer.followUpCalls.noShows,
        followUpShowed: acc.followUpShowed + closer.followUpCalls.callsShowed,
        totalSales: acc.totalSales + closer.sales,
        totalRevenue: acc.totalRevenue + closer.cashCollectedMinor,
      }),
      {
        newBookedCalls: 0,
        newCanceled: 0,
        newNoShows: 0,
        newShowed: 0,
        followUpBookedCalls: 0,
        followUpCanceled: 0,
        followUpNoShows: 0,
        followUpShowed: 0,
        totalSales: 0,
        totalRevenue: 0,
      },
    );

    const visibleRevenueMinor = teamTotals.totalRevenue;
    const visibleDealCount = teamTotals.totalSales;
    const totalBookedCalls =
      teamTotals.newBookedCalls + teamTotals.followUpBookedCalls;
    const totalCanceledCalls = teamTotals.newCanceled + teamTotals.followUpCanceled;
    const totalShowedCalls = teamTotals.newShowed + teamTotals.followUpShowed;

    return {
      closers: closerResults,
      teamTotals: {
        ...teamTotals,
        totalRevenueMinor: teamTotals.totalRevenue,
        newShowUpRate: toRate(
          teamTotals.newShowed,
          teamTotals.newBookedCalls - teamTotals.newCanceled,
        ),
        followUpShowUpRate: toRate(
          teamTotals.followUpShowed,
          teamTotals.followUpBookedCalls - teamTotals.followUpCanceled,
        ),
        overallShowUpRate: toRate(
          totalShowedCalls,
          totalBookedCalls - totalCanceledCalls,
        ),
        overallCloseRate: toRate(teamTotals.totalSales, totalShowedCalls),
        avgCashCollectedMinor:
          teamTotals.totalSales > 0
            ? teamTotals.totalRevenue / teamTotals.totalSales
            : null,
        excludedRevenueMinor:
          paymentSummary.totalRevenueMinor - visibleRevenueMinor,
        excludedSales: paymentSummary.totalDealCount - visibleDealCount,
      },
      isPaymentDataTruncated: paymentScan.isTruncated,
    };
  },
});
