import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { listFirstEnrollmentsInRange } from "../enrollments/firstEnrollments";
import { requireTenantUser } from "../requireTenantUser";
import { isSideDealOrigin } from "../lib/sideDeals";
import {
  getNonDisputedPaymentsInRange,
  splitPaymentsForRevenueReporting,
} from "../reporting/lib/helpers";

// New customers the dashboard reads in one period at most; past it the count
// is a lower bound. Production has 274 customers in all.
export const MAX_NEW_CUSTOMER_SCAN_ROWS = 2500;

/** A period's new customers; `isTruncated` says the read stopped at its cap. */
export type NewCustomerCount = { count: number; isTruncated: boolean };

/**
 * People whose first enrollment falls in [periodStart, periodEnd): a second
 * program doesn't count a person again (docs/plans/phase-4-customers.md §6.3).
 */
export async function countNewCustomersFromEnrollments(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  periodStart: number,
  periodEnd: number,
): Promise<NewCustomerCount> {
  const { enrollments, isTruncated } = await listFirstEnrollmentsInRange(
    ctx,
    tenantId,
    periodStart,
    periodEnd,
    MAX_NEW_CUSTOMER_SCAN_ROWS,
  );
  return { count: enrollments.length, isTruncated };
}

/**
 * Time-period scoped stats for the admin dashboard.
 *
 * Computes metrics within a [periodStart, periodEnd) window using indexed
 * range scans.
 */
export const getTimePeriodStats = query({
  args: {
    periodStart: v.number(),
    periodEnd: v.number(),
  },
  handler: async (ctx, { periodStart, periodEnd }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // 1. New opportunities created in period
    let newOpportunities = 0;
    for await (const opportunity of ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_createdAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("createdAt", periodStart)
          .lt("createdAt", periodEnd),
      )) {
      newOpportunities += opportunity._id ? 1 : 0;
    }

    // 2. Meetings scheduled in period
    let meetingsInPeriod = 0;
    for await (const meeting of ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("scheduledAt", periodStart)
          .lt("scheduledAt", periodEnd),
      )) {
      meetingsInPeriod += meeting._id ? 1 : 0;
    }

    // 3. Payments recorded in period → split KPIs + won deals (distinct opps)
    const paymentScan = await getNonDisputedPaymentsInRange(
      ctx,
      tenantId,
      periodStart,
      periodEnd,
    );
    const paymentSplit = splitPaymentsForRevenueReporting(paymentScan.payments);
    const closedWonOpportunityIds = new Set(
      paymentSplit.commissionable.finalPayments
        .map((payment) => payment.opportunityId)
        .filter(
          (opportunityId): opportunityId is NonNullable<typeof opportunityId> =>
            opportunityId !== undefined,
        ),
    );
    const sideDealPayments = paymentSplit.commissionable.allPayments.filter(
      (payment) => isSideDealOrigin(payment.origin),
    );
    const sideDealFinalOpportunityIds = new Set(
      paymentSplit.commissionable.finalPayments
        .filter((payment) => isSideDealOrigin(payment.origin))
        .map((payment) => payment.opportunityId)
        .filter(
          (opportunityId): opportunityId is NonNullable<typeof opportunityId> =>
            opportunityId !== undefined,
        ),
    );
    const paymentCountInPeriod = paymentSplit.filteredPayments.length;
    const closedWonInPeriod = paymentSplit.commissionable.finalRevenueMinor / 100;
    const depositsInPeriod =
      paymentSplit.commissionable.depositRevenueMinor / 100;
    const sideDealRevenueInPeriod =
      sideDealPayments.reduce((sum, payment) => sum + payment.amountMinor, 0) /
      100;
    const postConversionInPeriod =
      paymentSplit.nonCommissionable.finalRevenueMinor / 100;
    const postConversionDepositsInPeriod =
      paymentSplit.nonCommissionable.depositRevenueMinor / 100;
    const revenueInPeriod =
      closedWonInPeriod +
      depositsInPeriod +
      postConversionInPeriod +
      postConversionDepositsInPeriod;

    // 4. People whose first enrollment falls in the period
    const { count: newCustomers } = await countNewCustomersFromEnrollments(
      ctx,
      tenantId,
      periodStart,
      periodEnd,
    );

    return {
      newOpportunities,
      meetingsInPeriod,
      wonDealsInPeriod: closedWonOpportunityIds.size,
      closedWonInPeriod,
      depositsInPeriod,
      postConversionInPeriod,
      postConversionDepositsInPeriod,
      sideDealRevenueInPeriod,
      sideDealCountInPeriod: sideDealFinalOpportunityIds.size,
      revenueInPeriod,
      paymentCountInPeriod,
      newCustomers,
      isPaymentDataTruncated: paymentScan.isTruncated,
    };
  },
});
