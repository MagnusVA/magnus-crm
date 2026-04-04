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
    console.log(`[Webhook] persistRawEvent called: eventType=${args.eventType}, uri=${args.calendlyEventUri}`);

    const existingEvents = ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_tenantId_and_eventType", (q) =>
        q.eq("tenantId", args.tenantId).eq("eventType", args.eventType),
      )
      .order("desc");

    for await (const existing of existingEvents) {
      if (existing.calendlyEventUri === args.calendlyEventUri) {
        console.warn(
          `[Webhook] Duplicate detected: eventType=${args.eventType}, uri=${args.calendlyEventUri} — skipping`,
        );
        return null;
      }
    }

    const rawEventId = await ctx.db.insert("rawWebhookEvents", {
      ...args,
      processed: false,
      receivedAt: Date.now(),
    });

    console.log(`[Webhook] New event inserted: id=${rawEventId}, eventType=${args.eventType}`);

    // ==== NEW: Trigger pipeline processing ====
    await ctx.scheduler.runAfter(
      0,
      internal.pipeline.processor.processRawEvent,
      { rawEventId },
    );

    console.log(`[Webhook] Pipeline processing scheduled for rawEventId=${rawEventId}`);

    return rawEventId;
  },
});
