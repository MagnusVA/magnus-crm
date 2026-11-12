import { adoptRawDelivery } from "../pipeline/receipts";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "../_generated/server";

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

const counts = v.object({
  count: v.number(),
  oldestReceivedAt: v.optional(v.number()),
});

/** One small transaction per page, including payload bytes and receipt lookups. */
async function scanUnprocessedPage(
  ctx: QueryCtx,
  cursor: string | null,
  cutoffTimestamp: number,
) {
  const result = await ctx.db
    .query("rawWebhookEvents")
    .withIndex("by_processed_and_receivedAt", (q) =>
      q.eq("processed", false),
    )
    .paginate({ cursor, numItems: 32, maximumBytesRead: 512 * 1024 });
  const receiptless: { count: number; oldestReceivedAt?: number } = { count: 0 };
  const stale: { count: number; oldestReceivedAt?: number } = { count: 0 };
  for (const event of result.page) {
    const receipt = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_rawEventId", (q) => q.eq("rawEventId", event._id))
      .unique();
    if (!receipt) {
      receiptless.count++;
      receiptless.oldestReceivedAt ??= event.receivedAt;
    }
    if (event.receivedAt < cutoffTimestamp && receipt?.status !== "blocked") {
      stale.count++;
      stale.oldestReceivedAt ??= event.receivedAt;
    }
  }
  return {
    receiptless,
    stale,
    isDone: result.isDone,
    continueCursor: result.continueCursor,
  };
}

export const scanUnprocessedEvents = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), cutoffTimestamp: v.number() },
  returns: v.object({
    receiptless: counts,
    stale: counts,
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { cursor, cutoffTimestamp }) =>
    await scanUnprocessedPage(ctx, cursor, cutoffTimestamp),
});

export const heldBookingsWaiting = internalQuery({
  args: { cutoffTimestamp: v.number() },
  returns: v.object({
    count: v.number(),
    capped: v.boolean(),
    oldestReceivedAt: v.optional(v.number()),
    tenantIds: v.array(v.id("tenants")),
  }),
  handler: async (ctx, { cutoffTimestamp }) => {
    const held = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_status_and_receivedAt", (q) =>
        q.eq("status", "blocked").lt("receivedAt", cutoffTimestamp),
      )
      .take(101);
    return {
      count: Math.min(held.length, 100),
      capped: held.length > 100,
      oldestReceivedAt: held[0]?.receivedAt,
      tenantIds: [...new Set(held.map((receipt) => receipt.tenantId))].slice(0, 10),
    };
  },
});
