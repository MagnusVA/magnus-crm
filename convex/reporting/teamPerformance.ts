import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import {
  attendanceDayBounds,
  readScheduledAttendanceDay,
  isHeldStatus,
  withAttendanceCounts,
} from "../lib/meetingAttendance";
import {
  readMeetingStatsCounts,
  type MeetingStatsCount,
} from "../operations/meetingStats";
import { requireReportingReady } from "../operations/reportingReadiness";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import type { PaymentScan } from "./revenue";
import { memberAvatarIdentityValidator } from "../lib/memberIdentity";
import { requireTenantUser } from "../requireTenantUser";
import { meetingsByStatus } from "./aggregates";
import {
  closeRateOf,
  countCloseRateCohort,
  emptyCloseRateTally,
  readCloseRateCohort,
  tallyCloseRate,
  totalCloseRateTally,
  type CloseRateCohortCount,
} from "./lib/closeRateCohort";
import {
  assertValidDateRange,
  getActiveClosers,
  getNonDisputedPaymentsInRange,
  getUserDisplayName,
  makeTupleDateBounds,
  reportingUserIdentity,
  summarizePaymentsForRevenueReporting,
  summarizeAttributedPayments,
} from "./lib/helpers";

const CALL_CLASSIFICATIONS = ["new", "follow_up"] as const;
const MEETING_STATUSES = [
  "scheduled",
  "held",
  "canceled",
  "no_show",
] as const satisfies ReadonlyArray<Doc<"meetings">["status"]>;

export type CallClassification = (typeof CALL_CLASSIFICATIONS)[number];
export type MeetingStatus = (typeof MEETING_STATUSES)[number];
export type MeetingCountKey = {
  classification: CallClassification;
  closerId: Id<"users">;
  status: MeetingStatus;
};
type StatusCountMap = Record<MeetingStatus, number>;

function emptyStatusCountMap(): StatusCountMap {
  return {
    scheduled: 0,
    held: 0,
    canceled: 0,
    no_show: 0,
  };
}

function toRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Counts the meetings scheduled in `[startDate, endDate)` for each key, as the
 * meetingsByStatus aggregate keys them.
 */
export type TeamMeetingCounter = (
  keys: MeetingCountKey[],
  startDate: number,
  endDate: number,
) => Promise<number[]>;

/**
 * The range's close rate cohort (reporting/lib/closeRateCohort.ts) by closer
 * and booked program. `capped` when the live read hit its bound.
 */
export type TeamCloseRateCohort = {
  counts: CloseRateCohortCount[];
  capped: boolean;
};

/**
 * Per-closer attendance, revenue and close rate for a range. Shared by the
 * Convex reader and the ClickHouse report
 * (convex/analytics/definitions/team.ts).
 *
 * The close rate is the cohort close rate: of the deals whose first held call
 * is in the range, the share won now, each credited to that call's closer.
 * Payments play no part in it; sales and cash still come from payments.
 */
export async function buildTeamPerformanceMetrics(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  { startDate, endDate }: { startDate: number; endDate: number },
  {
    countMeetings,
    paymentScan,
    closeRateCohort,
  }: {
    countMeetings: TeamMeetingCounter;
    paymentScan: PaymentScan;
    closeRateCohort: TeamCloseRateCohort;
  },
) {
  const closers = await getActiveClosers(ctx, tenantId);

  const countMeta: MeetingCountKey[] = [];

  for (const closer of closers) {
    for (const classification of CALL_CLASSIFICATIONS) {
      for (const status of MEETING_STATUSES) {
        countMeta.push({
          closerId: closer._id,
          classification,
          status,
        });
      }
    }
  }

  const counts =
    countMeta.length > 0
      ? await countMeetings(countMeta, startDate, endDate)
      : [];

  const now = Date.now();
  const attendanceDay = attendanceDayBounds(now, await getTenantBusinessDay(ctx, tenantId));
  const pastEnd = Math.min(endDate, attendanceDay.start);
  const pastMeta = countMeta.filter((meta) => meta.status === "scheduled");
  const hasScheduled = counts.some(
    (count, index) => count > 0 && countMeta[index].status === "scheduled",
  );
  const [pastScheduled, currentScheduled] = await Promise.all([
    pastEnd > startDate
      ? countMeetings(pastMeta, startDate, pastEnd)
      : Promise.resolve(pastMeta.map(() => 0)),
    hasScheduled && startDate < attendanceDay.end && endDate > attendanceDay.start
      ? readScheduledAttendanceDay(ctx, tenantId, now)
      : Promise.resolve({ meetings: [], attendanceCountsPartial: false }),
  ]);
  const notRecordedByCloser = new Map<string, number>();
  for (const [index, meta] of pastMeta.entries()) {
    notRecordedByCloser.set(
      `${meta.closerId}:${meta.classification}`,
      pastScheduled[index],
    );
  }
  for (const meeting of currentScheduled.meetings) {
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

  const revenueSummary = summarizePaymentsForRevenueReporting(paymentScan.payments);
  const finalPayments = revenueSummary.finalPayments;
  const paymentSummary = summarizeAttributedPayments(
    finalPayments,
  );
  const activeCloserIds = new Set(closers.map((closer) => closer._id));
  const adminLoggedRevenueByCloser = new Map<Id<"users">, number>();

  for (const payment of finalPayments) {
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
  // A capped cohort would give a wrong rate, so the rates and their counts
  // are unknown rather than partial.
  const cohortCapped = closeRateCohort.capped;
  const cohortByCloser = tallyCloseRate(closeRateCohort.counts, (count) => count.closerId);
  const cohortTotal = totalCloseRateTally(closeRateCohort.counts);

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
    const cohort = cohortByCloser.get(closer._id) ?? emptyCloseRateTally();

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
      closeRate: cohortCapped ? null : closeRateOf(cohort),
      cohortDeals: cohortCapped ? null : cohort.cohortDeals,
      wonDeals: cohortCapped ? null : cohort.wonDeals,
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
      // Every cohort deal, a former closer's included.
      overallCloseRate: cohortCapped ? null : closeRateOf(cohortTotal),
      cohortDeals: cohortCapped ? null : cohortTotal.cohortDeals,
      wonDeals: cohortCapped ? null : cohortTotal.wonDeals,
      totalAdminLoggedRevenueMinor: teamTotals.totalAdminLoggedRevenueMinor,
      avgCashCollectedMinor:
        teamTotals.totalSales > 0
          ? teamTotals.totalRevenue / teamTotals.totalSales
          : null,
      excludedRevenueMinor:
        paymentSummary.totalRevenueMinor - visibleRevenueMinor,
      excludedSales: paymentSummary.totalDealCount - visibleDealCount,
    },
    attendanceCountsPartial: currentScheduled.attendanceCountsPartial,
    isPaymentDataTruncated: paymentScan.isTruncated,
    isCloseRateCohortTruncated: cohortCapped,
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

    const paymentScan = await getNonDisputedPaymentsInRange(
      ctx,
      tenantId,
      startDate,
      endDate,
    );
    return await buildTeamPerformanceMetrics(ctx, tenantId, { startDate, endDate }, {
      countMeetings: async (keys, from, to) =>
        await meetingsByStatus.countBatch(ctx, keys.map((key) => ({
          namespace: tenantId,
          bounds: makeTupleDateBounds(
            [key.closerId, key.classification, key.status],
            from,
            to,
          ),
        }))),
      paymentScan,
      closeRateCohort: await readTeamCloseRateCohort(ctx, tenantId, startDate, endDate),
    });
  },
});

async function readTeamCloseRateCohort(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  startDate: number,
  endDate: number,
): Promise<TeamCloseRateCohort> {
  const { deals, capped } = await readCloseRateCohort(ctx, tenantId, {
    start: startDate,
    end: endDate,
  });
  return { counts: countCloseRateCohort(deals), capped };
}

/**
 * Booked-call outcomes by phone closer from a range's meeting counts.
 * Shared by the Convex reader and the ClickHouse report
 * (convex/analytics/definitions/team.ts).
 */
export async function buildTeamOperationsDimensions(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  args: { bookingProgramId?: Id<"tenantPrograms"> | null },
  { counts, truncated }: { counts: MeetingStatsCount[]; truncated: boolean },
) {
  const closers = await getActiveClosers(ctx, tenantId);

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

  const attendance = await withAttendanceCounts(ctx, tenantId, counts);
  for (const row of attendance.counts) {
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
    attendanceCountsPartial: attendance.attendanceCountsPartial,
    truncated,
  };
}

export const getTeamOperationsDimensions = query({
  args: {
    startDayKey: v.string(),
    endDayKeyExclusive: v.string(),
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
    attendanceCountsPartial: v.boolean(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    await requireReportingReady(ctx, tenantId);

    if (args.startDayKey >= args.endDayKeyExclusive) {
      throw new Error("startDayKey must be before endDayKeyExclusive");
    }
    // A team or DM closer filter reads the credited meetings' rows
    // (dealAttributions); otherwise the buckets.
    const meetingCounts = await readMeetingStatsCounts(ctx, {
      tenantId,
      startDayKey: args.startDayKey,
      endDayKeyExclusive: args.endDayKeyExclusive,
      attributionTeamId: args.attributionTeamId,
      dmCloserId: args.dmCloserId,
    });
    return await buildTeamOperationsDimensions(ctx, tenantId, args, meetingCounts);
  },
});
