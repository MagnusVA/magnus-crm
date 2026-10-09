import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { log } from "../lib/observability/log";
import { updateTenantCalendlyConnection } from "../lib/tenantCalendlyConnection";

export const storeWebhookAndActivate = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    webhookUri: v.string(),
    webhookSecret: v.string(),
  },
  handler: async (ctx, { tenantId, webhookUri, webhookSecret }) => {
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) {
      log.warn("calendly.webhook_setup.rejected", {
        reason: "tenant_not_found",
        tenantId,
      });
      throw new Error("Tenant not found");
    }

    const isFirstOnboarding = !tenant.onboardingCompletedAt;
    await updateTenantCalendlyConnection(ctx, tenantId, {
      webhookUri,
      webhookSecret,
      connectionStatus: "connected",
      webhookProvisioningStartedAt: undefined,
    });
    await ctx.db.patch("tenants", tenantId, {
      status: "active" as const,
      onboardingCompletedAt: tenant.onboardingCompletedAt ?? Date.now(),
    });

    log.info("calendly.webhook.activated", {
      tenantId,
      previousStatus: tenant.status,
      isFirstOnboarding,
    });
  },
});
