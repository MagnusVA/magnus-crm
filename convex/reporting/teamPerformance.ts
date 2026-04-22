import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { meetingsByStatus } from "./aggregates";
import {
  assertValidDateRange,
  getActiveClosers,
  getNonDisputedPaymentsInRange,
  getUserDisplayName,
  makeTupleDateBounds,
  splitPaymentsForRevenueReporting,
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
const MAX_MEETING_TIME_SCAN_ROWS = 2000;

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
type MeetingTimeAccumulator = {
  startedMeetingsCount: number;
  onTimeStartCount: number;
  lateStartCount: number;
  totalLateStartMs: number;
  completedWithDurationCount: number;
  overranCount: number;
  totalOverrunMs: number;
  totalActualDurationMs: number;
  scheduleAdherentCount: number;
  manuallyCorrectedCount: number;
};

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

function emptyMeetingTimeAccumulator(): MeetingTimeAccumulator {
  return {
    startedMeetingsCount: 0,
    onTimeStartCount: 0,
    lateStartCount: 0,
    totalLateStartMs: 0,
    completedWithDurationCount: 0,
    overranCount: 0,
    totalOverrunMs: 0,
    totalActualDurationMs: 0,
    scheduleAdherentCount: 0,
    manuallyCorrectedCount: 0,
  };
}

function addMeetingTime(
  accumulator: MeetingTimeAccumulator,
  meetingTime: MeetingTimeAccumulator,
): MeetingTimeAccumulator {
  return {
    startedMeetingsCount:
      accumulator.startedMeetingsCount + meetingTime.startedMeetingsCount,
    onTimeStartCount: accumulator.onTimeStartCount + meetingTime.onTimeStartCount,
    lateStartCount: accumulator.lateStartCount + meetingTime.lateStartCount,
    totalLateStartMs: accumulator.totalLateStartMs + meetingTime.totalLateStartMs,
    completedWithDurationCount:
      accumulator.completedWithDurationCount + meetingTime.completedWithDurationCount,
    overranCount: accumulator.overranCount + meetingTime.overranCount,
    totalOverrunMs: accumulator.totalOverrunMs + meetingTime.totalOverrunMs,
    totalActualDurationMs:
      accumulator.totalActualDurationMs + meetingTime.totalActualDurationMs,
    scheduleAdherentCount:
      accumulator.scheduleAdherentCount + meetingTime.scheduleAdherentCount,
    manuallyCorrectedCount:
      accumulator.manuallyCorrectedCount + meetingTime.manuallyCorrectedCount,
  };
}

function toMeetingTimeKpis(meetingTime: MeetingTimeAccumulator) {
  return {
    ...meetingTime,
    onTimeStartRate: toRate(
      meetingTime.onTimeStartCount,
      meetingTime.startedMeetingsCount,
    ),
    avgLateStartMs:
      meetingTime.lateStartCount > 0
        ? meetingTime.totalLateStartMs / meetingTime.lateStartCount
        : null,
    overranRate: toRate(
      meetingTime.overranCount,
      meetingTime.completedWithDurationCount,
    ),
    avgOverrunMs:
      meetingTime.overranCount > 0
        ? meetingTime.totalOverrunMs / meetingTime.overranCount
        : null,
    avgActualDurationMs:
      meetingTime.completedWithDurationCount > 0
        ? meetingTime.totalActualDurationMs /
          meetingTime.completedWithDurationCount
        : null,
    scheduleAdherenceRate: toRate(
      meetingTime.scheduleAdherentCount,
      meetingTime.completedWithDurationCount,
    ),
  };
}

export const getTeamPerformanceMetrics = query({
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
    const paymentSplit = splitPaymentsForRevenueReporting(paymentScan.payments);
    const commissionableFinalPayments = paymentSplit.commissionable.finalPayments;
    const paymentSummary = summarizeAttributedPayments(
      commissionableFinalPayments,
    );
    const activeCloserIds = new Set(closers.map((closer) => closer._id));
    const adminLoggedRevenueByCloser = new Map<Id<"users">, number>();

    for (const payment of commissionableFinalPayments) {
      if (
        payment.effectiveCloserId === null ||
        payment.recordedByUserId === payment.effectiveCloserId ||
        !activeCloserIds.has(payment.effectiveCloserId)
      ) {
        continue;
      }

      adminLoggedRevenueByCloser.set(
        payment.effectiveCloserId,
        (adminLoggedRevenueByCloser.get(payment.effectiveCloserId) ?? 0) +
          payment.amountMinor,
      );
    }
    const meetingTimeRows = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q.eq("tenantId", tenantId).gte("scheduledAt", startDate).lt("scheduledAt", endDate),
      )
      .take(MAX_MEETING_TIME_SCAN_ROWS + 1);
    const isMeetingTimeTruncated =
      meetingTimeRows.length > MAX_MEETING_TIME_SCAN_ROWS;
    const meetingsForMeetingTime = meetingTimeRows.slice(0, MAX_MEETING_TIME_SCAN_ROWS);
    const meetingTimeByCloser = new Map<Id<"users">, MeetingTimeAccumulator>(
      closers.map((closer) => [closer._id, emptyMeetingTimeAccumulator()]),
    );

    for (const meeting of meetingsForMeetingTime) {
      if (meeting.status !== "completed" && meeting.status !== "meeting_overran") {
        continue;
      }

      const current = meetingTimeByCloser.get(meeting.assignedCloserId) ??
        emptyMeetingTimeAccumulator();
      const next = { ...current };

      if (meeting.startedAt !== undefined) {
        next.startedMeetingsCount += 1;
        const lateStartMs = meeting.lateStartDurationMs ?? 0;
        if (lateStartMs === 0) {
          next.onTimeStartCount += 1;
        } else {
          next.lateStartCount += 1;
          next.totalLateStartMs += lateStartMs;
        }
      }

      if (meeting.startedAt !== undefined && meeting.stoppedAt !== undefined) {
        next.completedWithDurationCount += 1;
        next.totalActualDurationMs += meeting.stoppedAt - meeting.startedAt;

        const overrunMs = meeting.exceededScheduledDurationMs ?? 0;
        if (overrunMs > 0) {
          next.overranCount += 1;
          next.totalOverrunMs += overrunMs;
        }

        const lateStartMs = meeting.lateStartDurationMs ?? 0;
        if (lateStartMs === 0 && overrunMs === 0) {
          next.scheduleAdherentCount += 1;
        }
      }

      if (
        meeting.startedAtSource === "admin_manual" ||
        meeting.stoppedAtSource === "admin_manual"
      ) {
        next.manuallyCorrectedCount += 1;
      }

      meetingTimeByCloser.set(meeting.assignedCloserId, next);
    }

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
        const noShows = countsForClassification.no_show;
        const reviewRequiredCalls = countsForClassification.meeting_overran;
        const callsShowed =
          countsForClassification.completed + countsForClassification.in_progress;
        const confirmedAttendanceDenominator =
          bookedCalls - canceledCalls - reviewRequiredCalls;

        return {
          bookedCalls,
          canceledCalls,
          noShows,
          reviewRequiredCalls,
          callsShowed,
          confirmedAttendanceDenominator,
          showUpRate: toRate(callsShowed, confirmedAttendanceDenominator),
        };
      };

      const newCalls = buildClassificationMetrics("new");
      const followUpCalls = buildClassificationMetrics("follow_up");
      const totalShowed = newCalls.callsShowed + followUpCalls.callsShowed;
      const meetingTime = toMeetingTimeKpis(
        meetingTimeByCloser.get(closer._id) ?? emptyMeetingTimeAccumulator(),
      );

      return {
        closerId: closer._id,
        closerName: getUserDisplayName(closer),
        newCalls,
        followUpCalls,
        meetingTime,
        sales: paymentStats.dealCount,
        cashCollectedMinor: paymentStats.revenueMinor,
        adminLoggedRevenueMinor:
          adminLoggedRevenueByCloser.get(closer._id) ?? 0,
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
        newReviewRequired:
          acc.newReviewRequired + closer.newCalls.reviewRequiredCalls,
        newShowed: acc.newShowed + closer.newCalls.callsShowed,
        followUpBookedCalls:
          acc.followUpBookedCalls + closer.followUpCalls.bookedCalls,
        followUpCanceled:
          acc.followUpCanceled + closer.followUpCalls.canceledCalls,
        followUpNoShows: acc.followUpNoShows + closer.followUpCalls.noShows,
        followUpReviewRequired:
          acc.followUpReviewRequired + closer.followUpCalls.reviewRequiredCalls,
        followUpShowed: acc.followUpShowed + closer.followUpCalls.callsShowed,
        totalSales: acc.totalSales + closer.sales,
        totalRevenue: acc.totalRevenue + closer.cashCollectedMinor,
        totalAdminLoggedRevenueMinor:
          acc.totalAdminLoggedRevenueMinor + closer.adminLoggedRevenueMinor,
      }),
      {
        newBookedCalls: 0,
        newCanceled: 0,
        newNoShows: 0,
        newReviewRequired: 0,
        newShowed: 0,
        followUpBookedCalls: 0,
        followUpCanceled: 0,
        followUpNoShows: 0,
        followUpReviewRequired: 0,
        followUpShowed: 0,
        totalSales: 0,
        totalRevenue: 0,
        totalAdminLoggedRevenueMinor: 0,
      },
    );
    const teamMeetingTimeTotals = closerResults.reduce(
      (accumulator, closer) => addMeetingTime(accumulator, closer.meetingTime),
      emptyMeetingTimeAccumulator(),
    );

    const visibleRevenueMinor = teamTotals.totalRevenue;
    const visibleDealCount = teamTotals.totalSales;
    const totalBookedCalls =
      teamTotals.newBookedCalls + teamTotals.followUpBookedCalls;
    const totalCanceledCalls = teamTotals.newCanceled + teamTotals.followUpCanceled;
    const totalReviewRequiredCalls =
      teamTotals.newReviewRequired + teamTotals.followUpReviewRequired;
    const totalShowedCalls = teamTotals.newShowed + teamTotals.followUpShowed;
    const overallConfirmedDenominator =
      totalBookedCalls - totalCanceledCalls - totalReviewRequiredCalls;

    return {
      closers: closerResults,
      teamTotals: {
        ...teamTotals,
        totalRevenueMinor: teamTotals.totalRevenue,
        postConversionRevenueMinor:
          paymentSplit.nonCommissionable.finalRevenueMinor,
        newConfirmedAttendanceDenominator:
          teamTotals.newBookedCalls -
          teamTotals.newCanceled -
          teamTotals.newReviewRequired,
        newShowUpRate: toRate(
          teamTotals.newShowed,
          teamTotals.newBookedCalls -
            teamTotals.newCanceled -
            teamTotals.newReviewRequired,
        ),
        followUpConfirmedAttendanceDenominator:
          teamTotals.followUpBookedCalls -
          teamTotals.followUpCanceled -
          teamTotals.followUpReviewRequired,
        followUpShowUpRate: toRate(
          teamTotals.followUpShowed,
          teamTotals.followUpBookedCalls -
            teamTotals.followUpCanceled -
            teamTotals.followUpReviewRequired,
        ),
        totalReviewRequired: totalReviewRequiredCalls,
        overallConfirmedDenominator,
        overallShowUpRate: toRate(totalShowedCalls, overallConfirmedDenominator),
        overallCloseRate: toRate(teamTotals.totalSales, totalShowedCalls),
        totalAdminLoggedRevenueMinor: teamTotals.totalAdminLoggedRevenueMinor,
        avgCashCollectedMinor:
          teamTotals.totalSales > 0
            ? teamTotals.totalRevenue / teamTotals.totalSales
            : null,
        excludedRevenueMinor:
          paymentSummary.totalRevenueMinor - visibleRevenueMinor,
        excludedSales: paymentSummary.totalDealCount - visibleDealCount,
      },
      teamMeetingTime: toMeetingTimeKpis(teamMeetingTimeTotals),
      isPaymentDataTruncated: paymentScan.isTruncated,
      isMeetingTimeTruncated,
    };
  },
});
