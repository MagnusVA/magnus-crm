import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const storeWebhookAndActivate = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    calendlyWebhookUri: v.string(),
    webhookSigningKey: v.string(),
  },
  handler: async (ctx, { tenantId, calendlyWebhookUri, webhookSigningKey }) => {
    console.log(`[Webhook:Setup] storeWebhookAndActivate: tenant ${tenantId}, webhookUri=${calendlyWebhookUri}`);

    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      console.error(`[Webhook:Setup] storeWebhookAndActivate: tenant ${tenantId} not found`);
      throw new Error("Tenant not found");
    }

    const isFirstOnboarding = !tenant.onboardingCompletedAt;
    await ctx.db.patch(tenantId, {
      calendlyWebhookUri,
      webhookSigningKey,
      status: "active" as const,
      onboardingCompletedAt: tenant.onboardingCompletedAt ?? Date.now(),
      webhookProvisioningStartedAt: undefined,
    });

    console.log(`[Webhook:Setup] storeWebhookAndActivate: tenant ${tenantId} activated, previousStatus=${tenant.status}, isFirstOnboarding=${isFirstOnboarding}`);
  },
});
