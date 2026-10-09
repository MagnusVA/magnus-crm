import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

export const persistRawEvent = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    calendlyEventUri: v.string(),
    eventType: v.string(),
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    const existingEvents = await ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_tenantId_and_eventType_and_calendlyEventUri", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("eventType", args.eventType)
          .eq("calendlyEventUri", args.calendlyEventUri),
      )
      .first();

    // Calendly retries deliveries; the caller logs `duplicate: true`.
    if (existingEvents) {
      return null;
    }

    const rawEventId = await ctx.db.insert("rawWebhookEvents", {
      ...args,
      processed: false,
      receivedAt: Date.now(),
    });

    await ctx.scheduler.runAfter(
      0,
      internal.pipeline.processor.processRawEvent,
      { rawEventId },
    );

    return rawEventId;
  },
});
