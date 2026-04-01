"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

export const runHealthCheck = internalAction({
  args: {},
  handler: async (ctx) => {
    const tenantIds = await ctx.runQuery(
      internal.calendly.tokenMutations.listActiveTenantIds,
    );

    for (const tenantId of tenantIds) {
      try {
        const tenant = await ctx.runQuery(internal.tenants.getCalendlyTokens, {
          tenantId,
        });
        if (!tenant?.calendlyAccessToken) continue;

        // 1. Introspect access token
        const clientId = process.env.CALENDLY_CLIENT_ID!;
        const clientSecret = process.env.CALENDLY_CLIENT_SECRET!;

        const introspectRes = await fetch("https://auth.calendly.com/oauth/introspect", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            token: tenant.calendlyAccessToken,
          }),
        });

        if (introspectRes.ok) {
          const data = await introspectRes.json();
          if (!data.active) {
            console.log(`Tenant ${tenantId}: token inactive, triggering refresh`);
            await ctx.runAction(internal.calendly.tokens.refreshTenantToken, {
              tenantId,
            });
          }
        }

        // 2. Check webhook subscription state
        // Note: Full tenant record needed for calendlyWebhookUri
        const fullTenant = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
          tenantId,
        });

        if (fullTenant?.calendlyWebhookUri) {
          // Extract webhook UUID from URI (format: https://calendly.com/webhook_subscriptions/{uuid})
          const webhookMatch = fullTenant.calendlyWebhookUri.match(
            /webhook_subscriptions\/([a-f0-9\-]+)$/,
          );
          if (webhookMatch) {
            const webhookUuid = webhookMatch[1];
            const webhookStateRes = await fetch(
              `https://api.calendly.com/webhook_subscriptions/${webhookUuid}`,
              {
                headers: { Authorization: `Bearer ${tenant.calendlyAccessToken}` },
              },
            );

            if (webhookStateRes.ok) {
              const webhookData = await webhookStateRes.json();
              if (webhookData.resource?.state === "disabled") {
                console.log(
                  `Tenant ${tenantId}: webhook subscription disabled, recreating`,
                );
                // Delete the disabled webhook
                await fetch(
                  `https://api.calendly.com/webhook_subscriptions/${webhookUuid}`,
                  {
                    method: "DELETE",
                    headers: { Authorization: `Bearer ${tenant.calendlyAccessToken}` },
                  },
                );
                // Trigger webhook provisioning via action
                await ctx.runAction(
                  internal.calendly.webhookSetup.provisionWebhooks,
                  { tenantId },
                );
              }
            }
          }
        }
      } catch (error) {
        console.error(`Health check failed for tenant ${tenantId}:`, error);
      }
    }
  },
});
