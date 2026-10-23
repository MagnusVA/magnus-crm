import {
  attendanceDayBounds,
  readScheduledAttendanceDay,
  isHeldStatus,
  withAttendanceCounts,
} from "../lib/meetingAttendance";
import {
  meetingDayKey,
  readMeetingStatsCounts,
} from "../operations/meetingStats";
import { requireReportingReady } from "../operations/reportingReadiness";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { memberAvatarIdentityValidator } from "../lib/memberIdentity";
import { requireTenantUser } from "../requireTenantUser";
import { meetingsByStatus } from "./aggregates";
import {
  assertValidDateRange,
  getActiveClosers,
  getNonDisputedPaymentsInRange,
  getUserDisplayName,
  makeTupleDateBounds,
  reportingUserIdentity,
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

    const now = Date.now();
    const attendanceDay = attendanceDayBounds(now);
    const pastEnd = Math.min(endDate, attendanceDay.start);
    const pastMeta = countMeta.filter((meta) => meta.status === "scheduled");
    const hasScheduled = counts.some(
      (count, index) => count > 0 && countMeta[index].status === "scheduled",
    );
    const [pastScheduled, currentScheduled] = await Promise.all([
      pastEnd > startDate
        ? meetingsByStatus.countBatch(ctx, pastMeta.map((meta) => ({
            namespace: tenantId,
            bounds: makeTupleDateBounds(
              [meta.closerId, meta.classification, meta.status],
              startDate,
              pastEnd,
            ),
          })))
        : Promise.resolve(pastMeta.map(() => 0)),
      hasScheduled && startDate < attendanceDay.end && endDate > attendanceDay.start
        ? readScheduledAttendanceDay(ctx, tenantId, now)
        : Promise.resolve([]),
    ]);
    const notRecordedByCloser = new Map<string, number>();
    for (const [index, meta] of pastMeta.entries()) {
      notRecordedByCloser.set(
        `${meta.closerId}:${meta.classification}`,
        pastScheduled[index],
      );
    }
    for (const meeting of currentScheduled) {
      if (
        meeting.scheduledAt < startDate || meeting.scheduledAt >= endDate ||
        meeting.scheduledAt + meeting.durationMinutes * 60_000 > now
      ) continue;
      const key = `${meeting.assignedCloserId}:${meeting.callClassification ?? "new"}`;
      notRecordedByCloser.set(key, (notRecordedByCloser.get(key) ?? 0) + 1);
    }

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
    const closerResults = await Promise.all(closers.map(async (closer) => {
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
        const callsShowed = MEETING_STATUSES.reduce(
          (sum, status) => sum + (isHeldStatus(status) ? countsForClassification[status] : 0),
          0,
        );
        const confirmedAttendanceDenominator = callsShowed + noShows;

        return {
          bookedCalls,
          canceledCalls,
          noShows,
          callsShowed,
          confirmedAttendanceDenominator,
          resultsRecorded: confirmedAttendanceDenominator,
          pastCalls: confirmedAttendanceDenominator +
            (notRecordedByCloser.get(`${closer._id}:${classification}`) ?? 0),
          showUpRate: toRate(callsShowed, confirmedAttendanceDenominator),
        };
      };

      const newCalls = buildClassificationMetrics("new");
      const followUpCalls = buildClassificationMetrics("follow_up");
      const totalShowed = newCalls.callsShowed + followUpCalls.callsShowed;

      return {
        closerId: closer._id,
        closerName: getUserDisplayName(closer),
        closer: await reportingUserIdentity(ctx, closer),
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
    }));

    const teamTotals = closerResults.reduce(
      (acc, closer) => ({
        newBookedCalls: acc.newBookedCalls + closer.newCalls.bookedCalls,
        newCanceled: acc.newCanceled + closer.newCalls.canceledCalls,
        newNoShows: acc.newNoShows + closer.newCalls.noShows,
        newShowed: acc.newShowed + closer.newCalls.callsShowed,
        newPastCalls: acc.newPastCalls + closer.newCalls.pastCalls,
        followUpBookedCalls:
          acc.followUpBookedCalls + closer.followUpCalls.bookedCalls,
        followUpCanceled:
          acc.followUpCanceled + closer.followUpCalls.canceledCalls,
        followUpNoShows: acc.followUpNoShows + closer.followUpCalls.noShows,
        followUpShowed: acc.followUpShowed + closer.followUpCalls.callsShowed,
        followUpPastCalls: acc.followUpPastCalls + closer.followUpCalls.pastCalls,
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
        newPastCalls: 0,
        followUpBookedCalls: 0,
        followUpCanceled: 0,
        followUpNoShows: 0,
        followUpShowed: 0,
        followUpPastCalls: 0,
        totalSales: 0,
        totalRevenue: 0,
        totalAdminLoggedRevenueMinor: 0,
      },
    );

    const visibleRevenueMinor = teamTotals.totalRevenue;
    const visibleDealCount = teamTotals.totalSales;
    const totalShowedCalls = teamTotals.newShowed + teamTotals.followUpShowed;
    const overallConfirmedDenominator = totalShowedCalls + teamTotals.newNoShows + teamTotals.followUpNoShows;

    return {
      closers: closerResults,
      teamTotals: {
        ...teamTotals,
        totalRevenueMinor: teamTotals.totalRevenue,
        postConversionRevenueMinor:
          paymentSplit.nonCommissionable.finalRevenueMinor,
        newConfirmedAttendanceDenominator:
          teamTotals.newShowed + teamTotals.newNoShows,
        newShowUpRate: toRate(
          teamTotals.newShowed,
          teamTotals.newShowed + teamTotals.newNoShows,
        ),
        followUpConfirmedAttendanceDenominator:
          teamTotals.followUpShowed + teamTotals.followUpNoShows,
        followUpShowUpRate: toRate(
          teamTotals.followUpShowed,
          teamTotals.followUpShowed + teamTotals.followUpNoShows,
        ),
        resultsRecorded: overallConfirmedDenominator,
        pastCalls: teamTotals.newPastCalls + teamTotals.followUpPastCalls,
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
  returns: v.object({
    rows: v.array(
      v.object({
        closerId: v.id("users"),
        closerName: v.string(),
        closer: memberAvatarIdentityValidator,
        scheduled: v.number(),
        completed: v.number(),
        canceled: v.number(),
        noShows: v.number(),
        notRecorded: v.number(),
        resultsRecorded: v.number(),
        pastCalls: v.number(),
        showRate: v.union(v.number(), v.null()),
        noShowRate: v.union(v.number(), v.null()),
      }),
    ),
    totals: v.object({
      scheduled: v.number(),
      completed: v.number(),
      canceled: v.number(),
      noShows: v.number(),
      notRecorded: v.number(),
      resultsRecorded: v.number(),
      pastCalls: v.number(),
      showRate: v.union(v.number(), v.null()),
      noShowRate: v.union(v.number(), v.null()),
    }),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    assertValidDateRange(args.startDate, args.endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    await requireReportingReady(ctx, tenantId);

    const startDayKey = meetingDayKey(args.startDate);
    const endDayKeyExclusive = meetingDayKey(args.endDate);
    // A team or DM closer filter reads the credited meetings' rows
    // (dealAttributions); otherwise the buckets.
    const [closers, { counts, truncated }] = await Promise.all([
      getActiveClosers(ctx, tenantId),
      readMeetingStatsCounts(ctx, {
        tenantId,
        startDayKey,
        endDayKeyExclusive,
        attributionTeamId: args.attributionTeamId,
        dmCloserId: args.dmCloserId,
      }),
    ]);

    const closerNameById = new Map(
      closers.map((closer) => [closer._id, getUserDisplayName(closer)]),
    );
    const closerById = new Map(closers.map((closer) => [closer._id, closer]));
    const byCloser = new Map<
      Id<"users">,
      {
        scheduled: number;
        completed: number;
        canceled: number;
        noShows: number;
        notRecorded: number;
      }
    >();

    for (const row of await withAttendanceCounts(ctx, tenantId, counts)) {
      if (
        args.bookingProgramId &&
        row.bookingProgramId !== args.bookingProgramId
      ) {
        continue;
      }

      const current = byCloser.get(row.assignedCloserId) ?? {
        scheduled: 0,
        completed: 0,
        canceled: 0,
        noShows: 0,
        notRecorded: 0,
      };
      current.scheduled += row.count;
      current.notRecorded += row.notRecorded;
      if (isHeldStatus(row.meetingStatus)) {
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

    const rows = (await Promise.all(
      [...byCloser.entries()].map(async ([closerId, totals]) => {
        const denominator = totals.completed + totals.noShows;
        return {
          closerId,
          closerName: closerNameById.get(closerId) ?? "Removed closer",
          closer: await reportingUserIdentity(
            ctx,
            closerById.get(closerId),
            "Removed closer",
          ),
          ...totals,
          resultsRecorded: denominator,
          pastCalls: denominator + totals.notRecorded,
          showRate: toRate(totals.completed, denominator),
          noShowRate: toRate(totals.noShows, denominator),
        };
      }),
    ))
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
        notRecorded: acc.notRecorded + row.notRecorded,
      }),
      { scheduled: 0, completed: 0, canceled: 0, noShows: 0, notRecorded: 0 },
    );
    const denominator = totals.completed + totals.noShows;

    return {
      rows,
      totals: {
        ...totals,
        resultsRecorded: denominator,
        pastCalls: denominator + totals.notRecorded,
        showRate: toRate(totals.completed, denominator),
        noShowRate: toRate(totals.noShows, denominator),
      },
      truncated,
    };
  },
});
