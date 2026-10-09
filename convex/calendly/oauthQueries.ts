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
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const tenant = await ctx.db.get("tenants", tenantId);
    const connection = await getTenantCalendlyConnectionState(ctx, tenantId);
    const now = Date.now();
    const eventTypeSyncInProgress =
      connection?.eventTypeSyncLockUntil !== undefined &&
      connection.eventTypeSyncLockUntil > now;

    if (!tenant) {
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
      eventTypeSyncInProgress,
      eventTypeSyncLockUntil: connection?.eventTypeSyncLockUntil ?? null,
      lastEventTypeSyncStartedAt:
        connection?.lastEventTypeSyncStartedAt ?? null,
      lastEventTypeSyncCompletedAt:
        connection?.lastEventTypeSyncCompletedAt ?? null,
      lastEventTypeSyncStatus: connection?.lastEventTypeSyncStatus ?? null,
      lastEventTypeSyncError: connection?.lastEventTypeSyncError ?? null,
      lastEventTypeSyncCount: connection?.lastEventTypeSyncCount ?? null,
      lastEventTypeSyncSummary: connection?.lastEventTypeSyncSummary ?? null,
    };

    return result;
  },
});
