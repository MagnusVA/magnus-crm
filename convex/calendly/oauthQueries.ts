import { buildCalendlyConnectionStatus } from "./oauthQueriesCore";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * Check if the current user's tenant needs Calendly reconnection.
 * Returns the tenant's Calendly connection status.
 */
export const getConnectionStatus = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    return await buildCalendlyConnectionStatus(ctx, tenantId);
  },
});
