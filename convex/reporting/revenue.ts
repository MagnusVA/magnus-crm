import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  attributePaymentsToClosers,
  getActiveClosers,
  getNonDisputedPaymentsInRange,
  getUserDisplayName,
  summarizeAttributedPayments,
} from "./lib/helpers";

const DEAL_SIZE_BUCKETS = {
  over10k: { count: 0, label: "$10k+" },
  to10k: { count: 0, label: "$5k - $9,999" },
  to2k: { count: 0, label: "$500 - $1,999" },
  to5k: { count: 0, label: "$2k - $4,999" },
  under500: { count: 0, label: "Under $500" },
} as const;

export const getRevenueMetrics = query({
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

    const byCloser = closers
      .map((closer) => {
        const paymentStats = paymentSummary.byCloser.get(closer._id) ?? {
          dealCount: 0,
          revenueMinor: 0,
        };

        return {
          closerId: closer._id,
          closerName: getUserDisplayName(closer),
          revenueMinor: paymentStats.revenueMinor,
          dealCount: paymentStats.dealCount,
          avgDealMinor:
            paymentStats.dealCount > 0
              ? paymentStats.revenueMinor / paymentStats.dealCount
              : null,
        };
      })
      .sort(
        (left, right) =>
          right.revenueMinor - left.revenueMinor ||
          left.closerName.localeCompare(right.closerName),
      );

    const totalRevenueMinor = byCloser.reduce(
      (sum, closer) => sum + closer.revenueMinor,
      0,
    );
    const totalDeals = byCloser.reduce((sum, closer) => sum + closer.dealCount, 0);

    return {
      totalRevenueMinor,
      totalDeals,
      avgDealMinor:
        totalDeals > 0 ? totalRevenueMinor / totalDeals : null,
      byCloser: byCloser.map((closer) => ({
        ...closer,
        revenuePercent:
          totalRevenueMinor > 0
            ? (closer.revenueMinor / totalRevenueMinor) * 100
            : 0,
      })),
      excludedRevenueMinor:
        paymentSummary.totalRevenueMinor - totalRevenueMinor,
      excludedDealCount: paymentSummary.totalDealCount - totalDeals,
      isPaymentDataTruncated: paymentScan.isTruncated,
    };
  },
});

export const getRevenueDetails = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
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
    const topPayments = [...paymentScan.payments]
      .sort(
        (left, right) =>
          right.amountMinor - left.amountMinor ||
          right.recordedAt - left.recordedAt,
      )
      .slice(0, 10);
    const attributedTopPayments = await attributePaymentsToClosers(ctx, topPayments);

    const closerIds = [
      ...new Set(
        attributedTopPayments
          .map((payment) => payment.effectiveCloserId)
          .filter((closerId): closerId is Id<"users"> => closerId !== null),
      ),
    ];
    const closerDocs = await Promise.all(
      closerIds.map(async (closerId) => [closerId, await ctx.db.get(closerId)] as const),
    );
    const closerById = new Map(closerDocs);

    const dealSizeDistribution = {
      under500: { ...DEAL_SIZE_BUCKETS.under500 },
      to2k: { ...DEAL_SIZE_BUCKETS.to2k },
      to5k: { ...DEAL_SIZE_BUCKETS.to5k },
      to10k: { ...DEAL_SIZE_BUCKETS.to10k },
      over10k: { ...DEAL_SIZE_BUCKETS.over10k },
    };

    for (const payment of paymentScan.payments) {
      const amountDollars = payment.amountMinor / 100;
      if (amountDollars < 500) {
        dealSizeDistribution.under500.count += 1;
      } else if (amountDollars < 2000) {
        dealSizeDistribution.to2k.count += 1;
      } else if (amountDollars < 5000) {
        dealSizeDistribution.to5k.count += 1;
      } else if (amountDollars < 10000) {
        dealSizeDistribution.to10k.count += 1;
      } else {
        dealSizeDistribution.over10k.count += 1;
      }
    }

    return {
      topDeals: attributedTopPayments.map((payment) => ({
        paymentRecordId: payment._id,
        amountMinor: payment.amountMinor,
        closerId: payment.effectiveCloserId,
        closerName:
          getUserDisplayName(
            payment.effectiveCloserId
              ? closerById.get(payment.effectiveCloserId) ?? null
              : null,
          ) ?? "Unknown",
        contextType: payment.contextType,
        customerId: payment.customerId ?? null,
        meetingId: payment.meetingId ?? null,
        opportunityId: payment.opportunityId ?? null,
        provider: payment.provider,
        recordedAt: payment.recordedAt,
      })),
      dealSizeDistribution,
      isPaymentDataTruncated: paymentScan.isTruncated,
    };
  },
});
