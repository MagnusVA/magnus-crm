"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { log, reportError } from "../lib/observability/log";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const cleanupExpiredEvents = internalAction({
  args: {},
  handler: async (ctx) => {
    const startedAt = Date.now();
    const cutoff = startedAt - RETENTION_MS;
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
    }

    // Alert on stale unprocessed events (never auto-delete these)
    const stale = await ctx.runQuery(
      internal.webhooks.cleanupMutations.countStaleUnprocessed,
      { cutoffTimestamp: cutoff },
    );
    if (stale.count > 0) {
      reportError(
        "pipeline.stuck_unprocessed_events",
        new Error("Raw webhook events left unprocessed for over 30 days"),
        {
          severity: "warning",
          fingerprint: "pipeline.stuck_unprocessed_events",
          integration: "calendly",
          staleCount: stale.count,
          staleCountCapped: stale.capped,
          oldestAgeMs:
            stale.oldestReceivedAt === undefined
              ? undefined
              : startedAt - stale.oldestReceivedAt,
        },
      );
    }

    log.info("pipeline.raw_event_cleanup.completed", {
      deletedCount: totalDeleted,
      iterations: iteration,
      staleUnprocessedCount: stale.count,
      durationMs: Date.now() - startedAt,
    });
  },
});
