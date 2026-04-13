import { internalMutation } from "../_generated/server";

export const backfillTenantCalendlyConnections = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tenants = await ctx.db.query("tenants").collect();
    let created = 0;
    let skipped = 0;

    for (const tenant of tenants) {
      const existing = await ctx.db
        .query("tenantCalendlyConnections")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenant._id))
        .first();

      if (existing) {
        skipped += 1;
        continue;
      }

      await ctx.db.insert("tenantCalendlyConnections", {
        tenantId: tenant._id,
        calendlyAccessToken: tenant.calendlyAccessToken,
        calendlyRefreshToken: tenant.calendlyRefreshToken,
        calendlyTokenExpiresAt: tenant.calendlyTokenExpiresAt,
        calendlyRefreshLockUntil: tenant.calendlyRefreshLockUntil,
        lastTokenRefreshAt: tenant.lastTokenRefreshAt,
        codeVerifier: tenant.codeVerifier,
        calendlyOrganizationUri: tenant.calendlyOrgUri,
        calendlyUserUri: tenant.calendlyOwnerUri,
        calendlyWebhookUri: tenant.calendlyWebhookUri,
        calendlyWebhookSigningKey: tenant.webhookSigningKey,
        connectionStatus:
          tenant.calendlyAccessToken || tenant.calendlyRefreshToken
            ? "connected"
            : "disconnected",
      });
      created += 1;
    }

    console.log(
      "[Migration:5A] backfillTenantCalendlyConnections complete",
      {
        created,
        skipped,
      },
    );

    return { created, skipped };
  },
});
