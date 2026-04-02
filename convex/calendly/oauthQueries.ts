import { query } from "../_generated/server";
import { getIdentityOrgId } from "../lib/identity";

/**
 * Check if the current user's tenant needs Calendly reconnection.
 * Returns the tenant's Calendly connection status.
 */
export const getConnectionStatus = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    const workosOrgId = getIdentityOrgId(identity);
    if (!workosOrgId) {
      return null;
    }

    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_workosOrgId", (q) => q.eq("workosOrgId", workosOrgId))
      .unique();

    if (!tenant) {
      return null;
    }

    return {
      tenantId: tenant._id,
      status: tenant.status,
      needsReconnect: tenant.status === "calendly_disconnected",
      lastTokenRefresh: tenant.calendlyTokenExpiresAt
        ? tenant.calendlyTokenExpiresAt - 7_200_000
        : null,
    };
  },
});
