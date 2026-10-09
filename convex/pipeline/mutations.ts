import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { reportError } from "../lib/observability/log";

/**
 * Mark a raw webhook event as processed.
 * Used by the pipeline dispatcher for unhandled event types,
 * and as a fallback for edge cases.
 */
export const markProcessed = internalMutation({
  args: { rawEventId: v.id("rawWebhookEvents") },
  handler: async (ctx, { rawEventId }) => {
    await ctx.db.patch("rawWebhookEvents", rawEventId, { processed: true });
  },
});

/** How long an event may sit unprocessed before it counts as stuck. */
const STUCK_AFTER_MS = 15 * 60 * 1000;
/** Report at most this many rows; one more is read to detect overflow. */
const MAX_REPORTED = 100;
const MAX_TENANT_IDS = 10;

/**
 * Reports raw Calendly webhook events that are still unprocessed 15 minutes
 * after they arrived. The processor runs within seconds of ingestion, and
 * nothing retries a failed run, so a stuck event means a booking, cancel, or
 * no-show that never reached the CRM.
 *
 * Runs from the `pipeline-stuck-events` cron. Read-only: it never marks or
 * replays events. A mutation rather than a query only because crons can't
 * schedule queries.
 */
export const reportStuckEvents = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const stuck = await ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_processed_and_receivedAt", (q) =>
        q.eq("processed", false).lt("receivedAt", now - STUCK_AFTER_MS),
      )
      .take(MAX_REPORTED + 1);

    if (stuck.length === 0) {
      return null;
    }

    const tenantIds: Array<Id<"tenants">> = [];
    for (const event of stuck) {
      if (tenantIds.length >= MAX_TENANT_IDS) break;
      if (!tenantIds.includes(event.tenantId)) tenantIds.push(event.tenantId);
    }

    reportError(
      "pipeline.events_stuck_unprocessed",
      new Error("Calendly webhook events unprocessed for over 15 minutes"),
      {
        severity: "error",
        integration: "calendly",
        fingerprint: "pipeline.events_stuck_unprocessed",
        staleCount: Math.min(stuck.length, MAX_REPORTED),
        staleCountCapped: stuck.length > MAX_REPORTED,
        // The index orders by receivedAt, so the first row is the oldest.
        oldestAgeMs: now - stuck[0].receivedAt,
        tenantIds,
      },
    );
    return null;
  },
});
