import type { getBookedVsSoldMatrix } from "../../reporting/bookedVsSold";
import type { getRevenueDetails, getRevenueMetrics } from "../../reporting/revenue";
import type { getRevenueTrend } from "../../reporting/revenueTrend";
import type { ReaderOutput } from "../definition";
import { addCounts, joinOntoToday, mergeRows, rate } from "./helpers";

// Revenue (app/workspace/reports/revenue): every panel sums the range's
// non-disputed payments, so the two answers add.

type RevenueMetrics = ReaderOutput<typeof getRevenueMetrics>;
type RevenueDetails = ReaderOutput<typeof getRevenueDetails>;
type RevenueTrend = ReaderOutput<typeof getRevenueTrend>;
type BookedVsSold = ReaderOutput<typeof getBookedVsSoldMatrix>;

const TOP_DEALS = 10;

export function mergeRevenueMetrics(history: RevenueMetrics, today: RevenueMetrics): RevenueMetrics {
  const finalRevenueMinor = history.revenue.finalRevenueMinor + today.revenue.finalRevenueMinor;
  const totalDeals = history.revenue.totalDeals + today.revenue.totalDeals;
  const byCloser = joinOntoToday(
    history.revenue.byCloser,
    today.revenue.byCloser,
    (closer) => closer.closerId,
    (past, current) => {
      const revenueMinor = past.revenueMinor + current.revenueMinor;
      const dealCount = past.dealCount + current.dealCount;
      return { ...current, revenueMinor, dealCount, avgDealMinor: rate(revenueMinor, dealCount) };
    },
  ).sort(
    (left, right) =>
      right.revenueMinor - left.revenueMinor || left.closerName.localeCompare(right.closerName),
  );
  const byProgram = mergeRows(
    history.revenue.byProgram,
    today.revenue.byProgram,
    (program) => program.programId ?? program.programName,
    (past, current) => ({
      ...current,
      finalRevenueMinor: past.finalRevenueMinor + current.finalRevenueMinor,
      depositRevenueMinor: past.depositRevenueMinor + current.depositRevenueMinor,
      paymentCount: past.paymentCount + current.paymentCount,
    }),
  ).sort(
    (left, right) =>
      right.finalRevenueMinor +
      right.depositRevenueMinor -
      (left.finalRevenueMinor + left.depositRevenueMinor),
  );
  return {
    revenue: {
      finalRevenueMinor,
      depositRevenueMinor: history.revenue.depositRevenueMinor + today.revenue.depositRevenueMinor,
      totalDeals,
      avgDealMinor: rate(finalRevenueMinor, totalDeals),
      byOrigin: addCounts(history.revenue.byOrigin, today.revenue.byOrigin),
      byCloser,
      byProgram,
    },
    byPaymentType: addCounts(history.byPaymentType, today.byPaymentType),
    isPaymentDataTruncated: history.isPaymentDataTruncated || today.isPaymentDataTruncated,
  };
}

/** One deal size bucket's count from both answers. */
function addBucket<Bucket extends { count: number }>(past: Bucket, current: Bucket): Bucket {
  // The builder's buckets are typed with the literal count they start at.
  return { ...current, count: past.count + current.count } as Bucket;
}

export function mergeRevenueDetails(history: RevenueDetails, today: RevenueDetails): RevenueDetails {
  const past = history.dealSizeDistribution;
  const current = today.dealSizeDistribution;
  return {
    // The ten largest of both answers' ten largest are the range's ten largest.
    topDeals: [...history.topDeals, ...today.topDeals]
      .sort((left, right) => right.amountMinor - left.amountMinor || right.recordedAt - left.recordedAt)
      .slice(0, TOP_DEALS),
    dealSizeDistribution: {
      under500: addBucket(past.under500, current.under500),
      to2k: addBucket(past.to2k, current.to2k),
      to5k: addBucket(past.to5k, current.to5k),
      to10k: addBucket(past.to10k, current.to10k),
      over10k: addBucket(past.over10k, current.over10k),
    },
    isPaymentDataTruncated: history.isPaymentDataTruncated || today.isPaymentDataTruncated,
  };
}

/** Periods in order; the week or month today falls in can hold days of both. */
export function mergeRevenueTrend(history: RevenueTrend, today: RevenueTrend): RevenueTrend {
  return {
    trend: mergeRows(history.trend, today.trend, (period) => period.periodKey, (past, current) => ({
      ...current,
      revenueMinor: past.revenueMinor + current.revenueMinor,
      dealCount: past.dealCount + current.dealCount,
      finalRevenueMinor: past.finalRevenueMinor + current.finalRevenueMinor,
      depositRevenueMinor: past.depositRevenueMinor + current.depositRevenueMinor,
    })),
    isPaymentDataTruncated: history.isPaymentDataTruncated || today.isPaymentDataTruncated,
  };
}

export function mergeBookedVsSold(history: BookedVsSold, today: BookedVsSold): BookedVsSold {
  return {
    rows: mergeRows(
      history.rows,
      today.rows,
      (row) => `${row.bookingProgramId}:${row.soldProgramId}`,
      (past, current) => ({
        ...current,
        paymentCount: past.paymentCount + current.paymentCount,
        totalAmountMinor: past.totalAmountMinor + current.totalAmountMinor,
      }),
    ).sort((left, right) => right.totalAmountMinor - left.totalAmountMinor),
    truncated: history.truncated || today.truncated,
  };
}
