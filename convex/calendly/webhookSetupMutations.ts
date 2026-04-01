import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const storeWebhookAndActivate = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    calendlyWebhookUri: v.string(),
    webhookSigningKey: v.string(),
  },
  handler: async (ctx, { tenantId, calendlyWebhookUri, webhookSigningKey }) => {
    await ctx.db.patch(tenantId, {
      calendlyWebhookUri,
      webhookSigningKey,
      status: "active" as const,
      onboardingCompletedAt: Date.now(),
    });
  },
});
