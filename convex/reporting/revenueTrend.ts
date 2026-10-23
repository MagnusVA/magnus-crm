import { v } from "convex/values";
import { query } from "../_generated/server";
import {
  paymentTypeValidator,
  resolvePaymentType,
} from "../lib/paymentTypes";
import { requireTenantUser } from "../requireTenantUser";
import {
  assertValidDateRange,
  attributePaymentsToClosers,
  getNonDisputedPaymentsInRange,
  summarizePaymentsForRevenueReporting,
} from "./lib/helpers";
import {
  getPeriodKey,
  getPeriodsInRange,
  type Granularity,
} from "./lib/periodBucketing";

export const getRevenueTrend = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    granularity: v.union(
      v.literal("day"),
      v.literal("week"),
      v.literal("month"),
    ),
    programId: v.optional(v.id("tenantPrograms")),
    paymentType: v.optional(paymentTypeValidator),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    assertValidDateRange(args.startDate, args.endDate);

    const periods = getPeriodsInRange(
      args.startDate,
      args.endDate,
      args.granularity,
    );
    const trend = periods.map((period) => ({
      periodKey: period.key,
      revenueMinor: 0,
      dealCount: 0,
      finalRevenueMinor: 0,
      depositRevenueMinor: 0,
      start: period.start,
      end: period.end,
    }));

    if (trend.length === 0) {
      return { trend: [], isPaymentDataTruncated: false };
    }

    const indexByPeriodKey = new Map<string, number>(
      trend.map((period, index) => [period.periodKey, index]),
    );
    const paymentScan = await getNonDisputedPaymentsInRange(
      ctx,
      tenantId,
      args.startDate,
      args.endDate,
    );
    const attributedPayments = await attributePaymentsToClosers(
      ctx,
      paymentScan.payments,
    );
    const filteredPayments = attributedPayments.filter(
      (payment) =>
        (!args.programId || payment.programId === args.programId) &&
        (!args.paymentType ||
          resolvePaymentType(payment.paymentType) === args.paymentType),
    );
    const summary = summarizePaymentsForRevenueReporting(filteredPayments);

    for (const payment of summary.finalPayments) {
      const periodKey = getPeriodKey(
        payment.recordedAt,
        args.granularity as Granularity,
      );
      const index = indexByPeriodKey.get(periodKey);
      if (index === undefined) {
        continue;
      }
      trend[index].revenueMinor += payment.amountMinor;
      trend[index].dealCount += 1;
      trend[index].finalRevenueMinor += payment.amountMinor;
    }

    for (const payment of summary.depositPayments) {
      const periodKey = getPeriodKey(
        payment.recordedAt,
        args.granularity as Granularity,
      );
      const index = indexByPeriodKey.get(periodKey);
      if (index !== undefined) {
        trend[index].depositRevenueMinor += payment.amountMinor;
      }
    }

    return {
      trend: trend.map(({ start, end, ...period }) => period),
      isPaymentDataTruncated: paymentScan.isTruncated,
    };
  },
});
