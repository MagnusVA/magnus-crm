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
    const limit = batchSize ?? 128;

    const expired = await ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_processed_and_receivedAt", (q) =>
        q.eq("processed", true).lt("receivedAt", cutoffTimestamp),
      )
      .take(limit);

    for (const event of expired) {
      await ctx.db.delete(event._id);
    }

    return { deleted: expired.length, hasMore: expired.length === limit };
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
    return { count: stale.length, capped: stale.length === 100 };
  },
});
