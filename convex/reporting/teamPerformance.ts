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
  "completed",
  "canceled",
  "no_show",
] as const satisfies ReadonlyArray<Doc<"meetings">["status"]>;
const MAX_OPERATIONS_STATS_ROWS = 1000;

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
    completed: 0,
    canceled: 0,
    no_show: 0,
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
        const callsShowed = countsForClassification.completed;
        const confirmedAttendanceDenominator = bookedCalls - canceledCalls;

        return {
          bookedCalls,
          canceledCalls,
          noShows,
          callsShowed,
          confirmedAttendanceDenominator,
          showUpRate: toRate(callsShowed, confirmedAttendanceDenominator),
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
        newShowed: acc.newShowed + closer.newCalls.callsShowed,
        followUpBookedCalls:
          acc.followUpBookedCalls + closer.followUpCalls.bookedCalls,
        followUpCanceled:
          acc.followUpCanceled + closer.followUpCalls.canceledCalls,
        followUpNoShows: acc.followUpNoShows + closer.followUpCalls.noShows,
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
        newShowed: 0,
        followUpBookedCalls: 0,
        followUpCanceled: 0,
        followUpNoShows: 0,
        followUpShowed: 0,
        totalSales: 0,
        totalRevenue: 0,
        totalAdminLoggedRevenueMinor: 0,
      },
    );

    const visibleRevenueMinor = teamTotals.totalRevenue;
    const visibleDealCount = teamTotals.totalSales;
    const totalBookedCalls =
      teamTotals.newBookedCalls + teamTotals.followUpBookedCalls;
    const totalCanceledCalls = teamTotals.newCanceled + teamTotals.followUpCanceled;
    const totalShowedCalls = teamTotals.newShowed + teamTotals.followUpShowed;
    const overallConfirmedDenominator = totalBookedCalls - totalCanceledCalls;

    return {
      closers: closerResults,
      teamTotals: {
        ...teamTotals,
        totalRevenueMinor: teamTotals.totalRevenue,
        postConversionRevenueMinor:
          paymentSplit.nonCommissionable.finalRevenueMinor,
        newConfirmedAttendanceDenominator:
          teamTotals.newBookedCalls - teamTotals.newCanceled,
        newShowUpRate: toRate(
          teamTotals.newShowed,
          teamTotals.newBookedCalls - teamTotals.newCanceled,
        ),
        followUpConfirmedAttendanceDenominator:
          teamTotals.followUpBookedCalls - teamTotals.followUpCanceled,
        followUpShowUpRate: toRate(
          teamTotals.followUpShowed,
          teamTotals.followUpBookedCalls - teamTotals.followUpCanceled,
        ),
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
      isPaymentDataTruncated: paymentScan.isTruncated,
    };
  },
});

export const getTeamOperationsDimensions = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
  },
  handler: async (ctx, args) => {
    assertValidDateRange(args.startDate, args.endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const startDayKey = new Date(args.startDate).toISOString().slice(0, 10);
    const endDayKeyExclusive = new Date(args.endDate).toISOString().slice(0, 10);
    const [closers, statsRows] = await Promise.all([
      getActiveClosers(ctx, tenantId),
      ctx.db
        .query("operationsMeetingDailyStats")
        .withIndex("by_tenantId_and_dayKey", (q) =>
          q
            .eq("tenantId", tenantId)
            .gte("dayKey", startDayKey)
            .lt("dayKey", endDayKeyExclusive),
        )
        .take(MAX_OPERATIONS_STATS_ROWS + 1),
    ]);

    const closerNameById = new Map(
      closers.map((closer) => [closer._id, getUserDisplayName(closer)]),
    );
    const byCloser = new Map<
      Id<"users">,
      {
        scheduled: number;
        completed: number;
        canceled: number;
        noShows: number;
      }
    >();

    for (const row of statsRows.slice(0, MAX_OPERATIONS_STATS_ROWS)) {
      if (
        args.bookingProgramId &&
        row.bookingProgramId !== args.bookingProgramId
      ) {
        continue;
      }
      if (
        args.attributionTeamId &&
        row.attributionTeamId !== args.attributionTeamId
      ) {
        continue;
      }
      if (args.dmCloserId && row.dmCloserId !== args.dmCloserId) {
        continue;
      }

      const current = byCloser.get(row.assignedCloserId) ?? {
        scheduled: 0,
        completed: 0,
        canceled: 0,
        noShows: 0,
      };
      current.scheduled += row.count;
      if (row.meetingStatus === "completed") {
        current.completed += row.count;
      }
      if (row.meetingStatus === "canceled") {
        current.canceled += row.count;
      }
      if (row.meetingStatus === "no_show") {
        current.noShows += row.count;
      }
      byCloser.set(row.assignedCloserId, current);
    }

    const rows = [...byCloser.entries()]
      .map(([closerId, totals]) => {
        const denominator = totals.scheduled - totals.canceled;
        return {
          closerId,
          closerName: closerNameById.get(closerId) ?? "Removed closer",
          ...totals,
          showRate: toRate(totals.completed, denominator),
          noShowRate: toRate(totals.noShows, denominator),
        };
      })
      .sort(
        (left, right) =>
          right.scheduled - left.scheduled ||
          left.closerName.localeCompare(right.closerName),
      );

    const totals = rows.reduce(
      (acc, row) => ({
        scheduled: acc.scheduled + row.scheduled,
        completed: acc.completed + row.completed,
        canceled: acc.canceled + row.canceled,
        noShows: acc.noShows + row.noShows,
      }),
      { scheduled: 0, completed: 0, canceled: 0, noShows: 0 },
    );
    const denominator = totals.scheduled - totals.canceled;

    return {
      rows,
      totals: {
        ...totals,
        showRate: toRate(totals.completed, denominator),
        noShowRate: toRate(totals.noShows, denominator),
      },
      truncated: statsRows.length > MAX_OPERATIONS_STATS_ROWS,
    };
  },
});
