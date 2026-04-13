import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * Aggregate stats for tenant owner/admin dashboard cards.
 */
export const getAdminDashboardStats = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    console.log("[Dashboard] getAdminDashboardStats called", { tenantId });

    const stats = await ctx.db
      .query("tenantStats")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();

    if (!stats) {
      console.warn("[Dashboard] getAdminDashboardStats missing tenantStats", {
        tenantId,
      });
      return {
        totalTeamMembers: 0,
        totalClosers: 0,
        unmatchedClosers: 0,
        totalOpportunities: 0,
        activeOpportunities: 0,
        meetingsToday: 0,
        wonDeals: 0,
        revenueLogged: 0,
        totalRevenue: 0,
        paymentRecordsLogged: 0,
      };
    }

    const start = new Date(Date.now());
    start.setHours(0, 0, 0, 0);
    const startOfDay = start.getTime();
    const endOfDay = startOfDay + 24 * 60 * 60 * 1000;

    let meetingsToday = 0;
    for await (const _meeting of ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("scheduledAt", startOfDay)
          .lt("scheduledAt", endOfDay),
      )) {
      meetingsToday += 1;
    }

    const revenueLogged = stats.totalRevenueMinor / 100;

    console.log("[Dashboard] getAdminDashboardStats completed", {
      tenantId,
      totalTeamMembers: stats.totalTeamMembers,
      totalClosers: stats.totalClosers,
      totalOpportunities: stats.totalOpportunities,
      activeOpportunities: stats.activeOpportunities,
      meetingsToday,
      wonDeals: stats.wonDeals,
      revenueLogged,
    });
    return {
      totalTeamMembers: stats.totalTeamMembers,
      totalClosers: stats.totalClosers,
      unmatchedClosers: 0,
      totalOpportunities: stats.totalOpportunities,
      activeOpportunities: stats.activeOpportunities,
      meetingsToday,
      wonDeals: stats.wonDeals,
      revenueLogged,
      totalRevenue: revenueLogged,
      paymentRecordsLogged: stats.totalPaymentRecords,
    };
  },
});

/**
 * Time-period scoped stats for the admin dashboard.
 *
 * Computes metrics within a [periodStart, periodEnd) window using indexed
 * range scans. Static counts (team size, active pipeline) stay in the
 * all-time query above — this query only returns time-bounded metrics.
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
    for await (const _opp of ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_createdAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("createdAt", periodStart)
          .lt("createdAt", periodEnd),
      )) {
      newOpportunities += 1;
    }

    // 2. Meetings scheduled in period
    let meetingsInPeriod = 0;
    for await (const _meeting of ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("scheduledAt", periodStart)
          .lt("scheduledAt", periodEnd),
      )) {
      meetingsInPeriod += 1;
    }

    // 3. Payments recorded in period → revenue + won deals (distinct opps)
    let revenueMinorInPeriod = 0;
    let paymentCountInPeriod = 0;
    const wonOpportunityIds = new Set<string>();
    for await (const payment of ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_recordedAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("recordedAt", periodStart)
          .lt("recordedAt", periodEnd),
      )) {
      if (payment.status !== "disputed") {
        revenueMinorInPeriod += payment.amountMinor;
        paymentCountInPeriod += 1;
      }
      if (payment.opportunityId) {
        wonOpportunityIds.add(payment.opportunityId);
      }
    }

    // 4. New customers converted in period
    let newCustomers = 0;
    for await (const _customer of ctx.db
      .query("customers")
      .withIndex("by_tenantId_and_convertedAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("convertedAt", periodStart)
          .lt("convertedAt", periodEnd),
      )) {
      newCustomers += 1;
    }

    return {
      newOpportunities,
      meetingsInPeriod,
      wonDealsInPeriod: wonOpportunityIds.size,
      revenueInPeriod: revenueMinorInPeriod / 100,
      paymentCountInPeriod,
      newCustomers,
    };
  },
});
