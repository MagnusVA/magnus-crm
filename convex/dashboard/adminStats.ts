import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const ACTIVE_OPPORTUNITY_STATUSES = new Set([
  "scheduled",
  "in_progress",
  "follow_up_scheduled",
]);

function getStartAndEndOfToday(timestamp: number) {
  const start = new Date(timestamp);
  start.setHours(0, 0, 0, 0);

  const startOfDay = start.getTime();
  const endOfDay = startOfDay + 24 * 60 * 60 * 1000;

  return { startOfDay, endOfDay };
}

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

    let totalTeamMembers = 0;
    let totalClosers = 0;
    let unmatchedClosers = 0;

    for await (const user of ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
      totalTeamMembers += 1;
      if (user.role === "closer") {
        totalClosers += 1;
        if (!user.calendlyUserUri) {
          unmatchedClosers += 1;
        }
      }
    }

    let totalOpportunities = 0;
    let activeOpportunities = 0;
    let wonDeals = 0;

    for await (const opportunity of ctx.db
      .query("opportunities")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
      totalOpportunities += 1;
      if (ACTIVE_OPPORTUNITY_STATUSES.has(opportunity.status)) {
        activeOpportunities += 1;
      }
      if (opportunity.status === "payment_received") {
        wonDeals += 1;
      }
    }

    const { startOfDay, endOfDay } = getStartAndEndOfToday(Date.now());
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

    let revenueLogged = 0;
    let paymentRecordsLogged = 0;
    for await (const paymentRecord of ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
      if (paymentRecord.status === "disputed") {
        continue;
      }
      revenueLogged += paymentRecord.amount;
      paymentRecordsLogged += 1;
    }

    return {
      totalTeamMembers,
      totalClosers,
      unmatchedClosers,
      totalOpportunities,
      activeOpportunities,
      meetingsToday,
      wonDeals,
      revenueLogged,
      totalRevenue: revenueLogged,
      paymentRecordsLogged,
    };
  },
});
