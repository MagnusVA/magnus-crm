import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const storeWebhookAndActivate = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    calendlyWebhookUri: v.string(),
    webhookSigningKey: v.string(),
  },
  handler: async (ctx, { tenantId, calendlyWebhookUri, webhookSigningKey }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    await ctx.db.patch(tenantId, {
      calendlyWebhookUri,
      webhookSigningKey,
      status: "active" as const,
      onboardingCompletedAt: tenant.onboardingCompletedAt ?? Date.now(),
      webhookProvisioningStartedAt: undefined,
    });
  },
});
