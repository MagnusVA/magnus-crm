import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { recordBookingFact } from "../pipeline/bookingFacts";
import { enqueueDelivery } from "../pipeline/delivery";
import { adoptRawDelivery, deliveryMetadata } from "../pipeline/receipts";

export const persistRawEvent = internalMutation({
  args: { tenantId: v.id("tenants"), calendlyEventUri: v.string(), eventType: v.string(), payload: v.string() },
  returns: v.union(v.id("rawWebhookEvents"), v.null()),
  handler: async (ctx, args) => {
    const receivedAt = Date.now();
    const { key, occurredAt, eventUri, payload } = await deliveryMetadata({ ...args, receivedAt });
    const existing = await ctx.db.query("webhookDeliveries")
      .withIndex("by_tenantId_and_key", q => q.eq("tenantId", args.tenantId).eq("key", key)).unique();
    if (existing) return null;
    // Widening compatibility: a provider redelivery must not replay old raw rows
    // while receipt adoption is still running.
    if (args.eventType === "invitee.created" || args.eventType === "invitee.canceled") {
      const legacy = await ctx.db.query("rawWebhookEvents").withIndex("by_tenantId_and_eventType_and_calendlyEventUri", q =>
        q.eq("tenantId", args.tenantId).eq("eventType", args.eventType).eq("calendlyEventUri", args.calendlyEventUri)).first();
      if (legacy) { await adoptRawDelivery(ctx, legacy); return null; }
    }
    const rawEventId = await ctx.db.insert("rawWebhookEvents", { ...args, processed: false, occurredAt, receivedAt });
    const deliveryId = await ctx.db.insert("webhookDeliveries", {
      tenantId: args.tenantId, key, inviteeUri: args.calendlyEventUri, eventUri,
      eventType: args.eventType, rawEventId, occurredAt, receivedAt, status: "queued", generation: 0,
    });
    await recordBookingFact(ctx, { tenantId: args.tenantId, eventType: args.eventType, eventUri, inviteeUri: args.calendlyEventUri, occurredAt, payload });
    await enqueueDelivery(ctx, deliveryId);
    return rawEventId;
  },
});
