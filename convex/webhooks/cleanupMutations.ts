import { adoptRawDelivery } from "../pipeline/receipts";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

/**
 * Delete a batch of processed webhook events older than the retention window.
 * Returns { deleted, hasMore } to support batched iteration.
 */
export const deleteExpiredEvents = internalMutation({
  args: {
    cutoffTimestamp: v.number(),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, { cutoffTimestamp, batchSize }) => {
    const limit = Math.max(1, Math.min(batchSize ?? 64, 128));
    const expired = await ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_processed_and_receivedAt", (q) =>
        q.eq("processed", true).lt("receivedAt", cutoffTimestamp),
      )
      .take(limit);

    let deleted = 0;
    for (const event of expired) {
      const receipt = await adoptRawDelivery(ctx, event);
      const duplicatePayload = receipt.rawEventId !== event._id && Boolean(await ctx.db.get("rawWebhookEvents", receipt.rawEventId));
      if (receipt.status === "applied" || receipt.status === "ignored" || duplicatePayload) {
        await ctx.db.delete("rawWebhookEvents", event._id);
        deleted++;
      } else {
        await ctx.db.patch("rawWebhookEvents", event._id, { processed: false });
      }
    }

    return { deleted, hasMore: expired.length === limit };
  },
});

/**
 * Count unprocessed events older than retention (for alerting, not deletion).
 */
export const countStaleUnprocessed = internalQuery({
  args: { cutoffTimestamp: v.number() },
  handler: async (ctx, { cutoffTimestamp }) => {
    const stale = await ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_processed_and_receivedAt", (q) =>
        q.eq("processed", false).lt("receivedAt", cutoffTimestamp),
      )
      .take(100);

    return {
      count: stale.length,
      capped: stale.length === 100,
      // The index orders by receivedAt, so the first row is the oldest.
      oldestReceivedAt: stale[0]?.receivedAt,
    };
  },
});
