import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { getTenantCalendlyConnectionState } from "../lib/tenantCalendlyConnection";

export const getTenantConnectionContext = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      return null;
    }

    const connection = await getTenantCalendlyConnectionState(ctx, tenantId);

    return {
      tenantId: tenant._id,
      companyName: tenant.companyName,
      workosOrgId: tenant.workosOrgId,
      tenantStatus: tenant.status,
      accessToken: connection?.accessToken,
      refreshToken: connection?.refreshToken,
      tokenExpiresAt: connection?.tokenExpiresAt,
      refreshLockUntil: connection?.refreshLockUntil,
      lastRefreshedAt: connection?.lastRefreshedAt,
      pkceVerifier: connection?.pkceVerifier,
      organizationUri: connection?.organizationUri,
      userUri: connection?.userUri,
      webhookUri: connection?.webhookUri,
      webhookSecret: connection?.webhookSecret,
      connectionStatus: connection?.connectionStatus,
      lastHealthCheckAt: connection?.lastHealthCheckAt,
    };
  },
});
