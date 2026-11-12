"use node";

import { v } from "convex/values";
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

    log.info("pipeline.raw_event_cleanup.completed", {
      deletedCount: totalDeleted,
      iterations: iteration,
      durationMs: Date.now() - startedAt,
    });
  },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SCAN_PAGES = 32;

/** Daily signals, with a continuation so old holds cannot hide later raw rows. */
export const reportUnresolvedEvents = internalAction({
  args: {
    cursor: v.optional(v.string()),
    asOf: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = args.asOf ?? Date.now();
    if (args.cursor === undefined) {
      const held = await ctx.runQuery(
        internal.webhooks.cleanupMutations.heldBookingsWaiting,
        { cutoffTimestamp: now - DAY_MS },
      );
      if (held.count) {
        reportError(
          "pipeline.held_bookings_waiting",
          new Error("Bookings held for over 24 hours need a person"),
          {
            severity: "warning",
            integration: "calendly",
            fingerprint: "pipeline.held_bookings_waiting",
            count: held.count,
            capped: held.capped,
            oldestAgeMs: now - held.oldestReceivedAt!,
            tenantIds: held.tenantIds,
          },
        );
      }
    }
    let cursor = args.cursor ?? null;
    let isDone = false;
    const totals: Record<
      "receiptless" | "stale",
      { count: number; oldestReceivedAt?: number }
    > = {
      receiptless: { count: 0 },
      stale: { count: 0 },
    };
    for (let page = 0; page < MAX_SCAN_PAGES && !isDone; page++) {
      const result = await ctx.runQuery(
        internal.webhooks.cleanupMutations.scanUnprocessedEvents,
        { cursor, cutoffTimestamp: now - RETENTION_MS },
      );
      for (const key of ["receiptless", "stale"] as const) {
        totals[key].count += result[key].count;
        totals[key].oldestReceivedAt ??= result[key].oldestReceivedAt;
      }
      cursor = result.continueCursor;
      isDone = result.isDone;
    }
    for (const [key, fingerprint, message, severity] of [
      [
        "receiptless",
        "pipeline.raw_events_without_receipt",
        "Raw webhook events have no delivery receipt",
        "error",
      ],
      [
        "stale",
        "pipeline.stuck_unprocessed_events",
        "Raw webhook events left unprocessed for over 30 days",
        "warning",
      ],
    ] as const) {
      const total = totals[key];
      if (!total.count) continue;
      reportError(fingerprint, new Error(message), {
        severity,
        fingerprint,
        integration: "calendly",
        staleCount: total.count,
        staleCountCapped: !isDone,
        oldestAgeMs: now - total.oldestReceivedAt!,
      });
    }
    if (!isDone && cursor !== null) {
      await ctx.scheduler.runAfter(
        0,
        internal.webhooks.cleanup.reportUnresolvedEvents,
        { cursor, asOf: now },
      );
    }
    return null;
  },
});
