import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  assertValidDateRange,
  getNonDisputedPaymentsInRange,
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
  },
  handler: async (ctx, { startDate, endDate, granularity }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    assertValidDateRange(startDate, endDate);

    const periods = getPeriodsInRange(startDate, endDate, granularity);
    const trend = periods.map((period) => ({
      periodKey: period.key,
      revenueMinor: 0,
      dealCount: 0,
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
      startDate,
      endDate,
    );

    for (const payment of paymentScan.payments) {
      const periodKey = getPeriodKey(payment.recordedAt, granularity as Granularity);
      const index = indexByPeriodKey.get(periodKey);
      if (index === undefined) {
        continue;
      }
      trend[index].revenueMinor += payment.amountMinor;
      trend[index].dealCount += 1;
    }

    return {
      trend: trend.map(({ start, end, ...period }) => period),
      isPaymentDataTruncated: paymentScan.isTruncated,
    };
  },
});
