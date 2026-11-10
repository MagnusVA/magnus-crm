import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import {
  paymentTypeValidator,
  resolvePaymentType,
  type PaymentType,
} from "../lib/paymentTypes";
import { requireTenantUser } from "../requireTenantUser";
import type { PaymentScan } from "./revenue";
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

export type RevenueTrendArgs = {
  startDate: number;
  endDate: number;
  granularity: Granularity;
  programId?: Id<"tenantPrograms"> | null;
  paymentType?: PaymentType | null;
};

/**
 * Revenue by period from a range's non-disputed payments, bucketed by the
 * tenant's business day. Shared by the Convex reader and the ClickHouse
 * report (convex/analytics/definitions/revenue.ts).
 */
export async function buildRevenueTrend(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  args: RevenueTrendArgs,
  paymentScan: PaymentScan,
) {
  const setting = await getTenantBusinessDay(ctx, tenantId);
  const periods = getPeriodsInRange(
    args.startDate,
    args.endDate,
    args.granularity,
    setting,
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
    return { trend: [], isPaymentDataTruncated: paymentScan.isTruncated };
  }

  const indexByPeriodKey = new Map<string, number>(
    trend.map((period, index) => [period.periodKey, index]),
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
      setting,
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
      setting,
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
}

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
    const paymentScan = await getNonDisputedPaymentsInRange(
      ctx,
      tenantId,
      args.startDate,
      args.endDate,
    );
    return await buildRevenueTrend(ctx, tenantId, args, paymentScan);
  },
});
