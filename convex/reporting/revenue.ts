import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import {
  paymentTypeValidator,
  resolvePaymentType,
} from "../lib/paymentTypes";
import { requireTenantUser } from "../requireTenantUser";
import {
  assertValidDateRange,
  attributePaymentsToClosers,
  PAYMENT_ORIGINS,
  getActiveClosers,
  getNonDisputedPaymentsInRange,
  getUserDisplayName,
  reportingUserIdentity,
  summarizePaymentsForRevenueReporting,
} from "./lib/helpers";

const DEAL_SIZE_BUCKETS = {
  over10k: { count: 0, label: "$10k+" },
  to10k: { count: 0, label: "$5k - $9,999" },
  to2k: { count: 0, label: "$500 - $1,999" },
  to5k: { count: 0, label: "$2k - $4,999" },
  under500: { count: 0, label: "Under $500" },
} as const;

function makeProgramBreakdown(
  payments: ReturnType<typeof summarizePaymentsForRevenueReporting>["allPayments"],
) {
  const byProgram = new Map<
    string,
    {
      programId: Id<"tenantPrograms"> | null;
      programName: string;
      finalRevenueMinor: number;
      depositRevenueMinor: number;
      paymentCount: number;
    }
  >();

  for (const payment of payments) {
    const key = payment.programId ?? payment.programName ?? "unknown";
    const existing = byProgram.get(key) ?? {
      programId: payment.programId ?? null,
      programName: payment.programName ?? "Unknown Program",
      finalRevenueMinor: 0,
      depositRevenueMinor: 0,
      paymentCount: 0,
    };
    existing.paymentCount += 1;
    if (payment.paymentType === "deposit") {
      existing.depositRevenueMinor += payment.amountMinor;
    } else {
      existing.finalRevenueMinor += payment.amountMinor;
    }
    byProgram.set(key, existing);
  }

  return [...byProgram.values()].sort(
    (left, right) =>
      right.finalRevenueMinor +
      right.depositRevenueMinor -
      (left.finalRevenueMinor + left.depositRevenueMinor),
  );
}

export const getRevenueMetrics = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    programId: v.optional(v.id("tenantPrograms")),
    paymentType: v.optional(paymentTypeValidator),
  },
  handler: async (ctx, args) => {
    assertValidDateRange(args.startDate, args.endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const closers = await getActiveClosers(ctx, tenantId);
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

    const byOrigin = Object.fromEntries(
      PAYMENT_ORIGINS.map((origin) => [origin, 0]),
    ) as Record<(typeof PAYMENT_ORIGINS)[number], number>;
    for (const payment of summary.finalPayments) {
      if (payment.origin && payment.origin in byOrigin) {
        byOrigin[
          payment.origin as keyof typeof byOrigin
        ] += payment.amountMinor;
      }
    }

    const byCloser = (await Promise.all(closers
      .map(async (closer) => {
        const closerPayments = summary.finalPayments.filter(
          (payment) => payment.effectiveCloserId === closer._id,
        );
        const revenueMinor = closerPayments.reduce(
          (sum, payment) => sum + payment.amountMinor,
          0,
        );
        const dealCount = closerPayments.length;
        return {
          closerId: closer._id,
          closerName: getUserDisplayName(closer),
          closer: await reportingUserIdentity(ctx, closer),
          revenueMinor,
          dealCount,
          avgDealMinor: dealCount > 0 ? revenueMinor / dealCount : null,
        };
      })))
      .sort(
        (left, right) =>
          right.revenueMinor - left.revenueMinor ||
          left.closerName.localeCompare(right.closerName),
      );

    const byPaymentType = {
      monthly: 0,
      split: 0,
      pif: 0,
      deposit: 0,
    };
    for (const payment of summary.allPayments) {
      byPaymentType[resolvePaymentType(payment.paymentType)] += payment.amountMinor;
    }

    return {
      revenue: {
        finalRevenueMinor: summary.finalRevenueMinor,
        depositRevenueMinor: summary.depositRevenueMinor,
        totalDeals: summary.finalPayments.length,
        avgDealMinor:
          summary.finalPayments.length > 0
            ? summary.finalRevenueMinor /
              summary.finalPayments.length
            : null,
        byOrigin,
        byCloser,
        byProgram: makeProgramBreakdown(summary.allPayments),
      },
      byPaymentType,
      isPaymentDataTruncated: paymentScan.isTruncated,
    };
  },
});

export const getRevenueDetails = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    programId: v.optional(v.id("tenantPrograms")),
    paymentType: v.optional(paymentTypeValidator),
  },
  handler: async (ctx, args) => {
    assertValidDateRange(args.startDate, args.endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

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
    const topPayments = [...summary.finalPayments]
      .sort(
        (left, right) =>
          right.amountMinor - left.amountMinor ||
          right.recordedAt - left.recordedAt,
      )
      .slice(0, 10);

    const closerIds = [
      ...new Set(
        topPayments
          .map((payment) => payment.effectiveCloserId)
          .filter((closerId): closerId is Id<"users"> => closerId !== null),
      ),
    ];
    const closerDocs = await Promise.all(
      closerIds.map(async (closerId) => [closerId, await ctx.db.get("users", closerId)] as const),
    );
    const closerById = new Map(closerDocs);

    const dealSizeDistribution = {
      under500: { ...DEAL_SIZE_BUCKETS.under500 },
      to2k: { ...DEAL_SIZE_BUCKETS.to2k },
      to5k: { ...DEAL_SIZE_BUCKETS.to5k },
      to10k: { ...DEAL_SIZE_BUCKETS.to10k },
      over10k: { ...DEAL_SIZE_BUCKETS.over10k },
    };

    for (const payment of summary.finalPayments) {
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
      topDeals: await Promise.all(topPayments.map(async (payment) => {
        const attributedCloser = payment.effectiveCloserId
          ? closerById.get(payment.effectiveCloserId) ?? null
          : null;
        return {
          paymentRecordId: payment._id,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          attributedCloserId: payment.effectiveCloserId,
          attributedCloserName: getUserDisplayName(attributedCloser) ?? "Unknown",
          attributedCloser: await reportingUserIdentity(
            ctx,
            attributedCloser,
            "Unknown closer",
          ),
          meetingId: payment.meetingId ?? null,
          opportunityId: payment.opportunityId ?? null,
          programId: payment.programId,
          programName: payment.programName,
          paymentType: payment.paymentType,
          origin: payment.origin,
          recordedAt: payment.recordedAt,
        };
      })),
      dealSizeDistribution,
      isPaymentDataTruncated: paymentScan.isTruncated,
    };
  },
});
