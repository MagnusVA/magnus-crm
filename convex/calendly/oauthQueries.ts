import { query } from "../_generated/server";
import { getTenantCalendlyConnectionState } from "../lib/tenantCalendlyConnection";
import { requireTenantUser } from "../requireTenantUser";

/**
 * Check if the current user's tenant needs Calendly reconnection.
 * Returns the tenant's Calendly connection status.
 */
export const getConnectionStatus = query({
  args: {},
  handler: async (ctx) => {
    console.log(`[Calendly:OAuth] getConnectionStatus: called`);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const tenant = await ctx.db.get(tenantId);
    const connection = await getTenantCalendlyConnectionState(ctx, tenantId);

    if (!tenant) {
      console.warn(`[Calendly:OAuth] getConnectionStatus: tenant ${tenantId} not found`);
      return null;
    }

    const result = {
      tenantId: tenant._id,
      status: tenant.status,
      needsReconnect: tenant.status === "calendly_disconnected",
      lastTokenRefresh: connection?.lastRefreshedAt ?? null,
      tokenExpiresAt: connection?.tokenExpiresAt ?? null,
      calendlyWebhookUri: connection?.webhookUri ?? null,
      hasWebhookSigningKey: Boolean(connection?.webhookSecret),
      hasAccessToken: Boolean(connection?.accessToken),
      hasRefreshToken: Boolean(connection?.refreshToken),
    };

    console.log(`[Calendly:OAuth] getConnectionStatus: tenant=${tenantId}, status=${result.status}, needsReconnect=${result.needsReconnect}, hasAccessToken=${result.hasAccessToken}, hasRefreshToken=${result.hasRefreshToken}`);

    return result;
  },
});
