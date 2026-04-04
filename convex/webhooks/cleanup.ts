"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const cleanupExpiredEvents = internalAction({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RETENTION_MS;
    let totalDeleted = 0;
    let hasMore = true;

    let iteration = 0;
    while (hasMore) {
      iteration += 1;
      const result = await ctx.runMutation(
        internal.webhooks.cleanupMutations.deleteExpiredEvents,
        { cutoffTimestamp: cutoff },
      );
      totalDeleted += result.deleted;
      hasMore = result.hasMore;
      console.log(`[webhook-cleanup] Iteration ${iteration}: deleted ${result.deleted} events (hasMore=${result.hasMore})`);
    }

    // Alert on stale unprocessed events (never auto-delete these)
    const stale = await ctx.runQuery(
      internal.webhooks.cleanupMutations.countStaleUnprocessed,
      { cutoffTimestamp: cutoff },
    );
    if (stale.count > 0) {
      console.warn(
        `[webhook-cleanup] ${stale.count}${stale.capped ? "+" : ""} ` +
        `unprocessed events older than 30 days — investigate.`,
      );
    }

    console.log(`[webhook-cleanup] Complete: deleted ${totalDeleted} expired events across ${iteration} iteration(s).`);
  },
});
