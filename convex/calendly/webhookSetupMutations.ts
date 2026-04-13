import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { updateTenantCalendlyConnection } from "../lib/tenantCalendlyConnection";

export const storeWebhookAndActivate = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    webhookUri: v.string(),
    webhookSecret: v.string(),
  },
  handler: async (ctx, { tenantId, webhookUri, webhookSecret }) => {
    console.log(
      `[Webhook:Setup] storeWebhookAndActivate: tenant ${tenantId}, webhookUri=${webhookUri}`,
    );

    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      console.error(
        `[Webhook:Setup] storeWebhookAndActivate: tenant ${tenantId} not found`,
      );
      throw new Error("Tenant not found");
    }

    const isFirstOnboarding = !tenant.onboardingCompletedAt;
    await updateTenantCalendlyConnection(ctx, tenantId, {
      webhookUri,
      webhookSecret,
      connectionStatus: "connected",
    });
    await ctx.db.patch(tenantId, {
      status: "active" as const,
      onboardingCompletedAt: tenant.onboardingCompletedAt ?? Date.now(),
      webhookProvisioningStartedAt: undefined,
    });

    console.log(
      `[Webhook:Setup] storeWebhookAndActivate: tenant ${tenantId} activated, previousStatus=${tenant.status}, isFirstOnboarding=${isFirstOnboarding}`,
    );
  },
});
