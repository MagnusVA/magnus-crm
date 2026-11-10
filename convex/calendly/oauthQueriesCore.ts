import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { getTenantCalendlyConnectionState } from "../lib/tenantCalendlyConnection";
export async function buildCalendlyConnectionStatus(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
) {
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
    lastEventTypeSyncStartedAt: connection?.lastEventTypeSyncStartedAt ?? null,
    lastEventTypeSyncCompletedAt:
      connection?.lastEventTypeSyncCompletedAt ?? null,
    lastEventTypeSyncStatus: connection?.lastEventTypeSyncStatus ?? null,
    lastEventTypeSyncError: connection?.lastEventTypeSyncError ?? null,
    lastEventTypeSyncCount: connection?.lastEventTypeSyncCount ?? null,
    lastEventTypeSyncSummary: connection?.lastEventTypeSyncSummary ?? null,
  };

  return result;
}
