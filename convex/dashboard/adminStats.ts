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
