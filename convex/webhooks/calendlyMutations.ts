import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const persistRawEvent = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    calendlyEventUri: v.string(),
    eventType: v.string(),
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    // Idempotency check: skip if we already have this event
    const existing = await ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_calendlyEventUri", (q) =>
        q.eq("calendlyEventUri", args.calendlyEventUri),
      )
      .unique();

    if (existing) {
      console.log(`Duplicate webhook event ${args.calendlyEventUri}, skipping`);
      return;
    }

    await ctx.db.insert("rawWebhookEvents", {
      ...args,
      processed: false,
      receivedAt: Date.now(),
    });
  },
});
