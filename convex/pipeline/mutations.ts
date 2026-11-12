import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
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

/** How long a receipt may wait for its current queue attempt. */
const STUCK_AFTER_MS = 15 * 60 * 1000;
const MAX_REPORTED = 100;
const MAX_TENANT_IDS = 10;

/** Read-only watchdog. Deliberately held bookings are not processing failures. */
export const reportStuckEvents = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - STUCK_AFTER_MS;
    const queued = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_status_and_queuedAt", (q) =>
        q.eq("status", "queued").gte("queuedAt", 0).lt("queuedAt", cutoff),
      )
      .take(MAX_REPORTED + 1);
    // Missing optional values sort before numbers. Keep legacy receipts in a
    // separate bounded range so they cannot crowd out current queue attempts.
    const legacy = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_status_and_queuedAt", (q) =>
        q.eq("status", "queued").eq("queuedAt", undefined),
      )
      .take(MAX_REPORTED + 1);
    const failed = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_status_and_receivedAt", (q) => q.eq("status", "failed"))
      .take(MAX_REPORTED + 1);

    const report = (
      fingerprint: string,
      message: string,
      receipts: Doc<"webhookDeliveries">[],
      ageFrom: (receipt: Doc<"webhookDeliveries">) => number,
    ) => {
      if (!receipts.length) return;
      const tenantIds: Array<Id<"tenants">> = [];
      for (const receipt of receipts) {
        if (tenantIds.length >= MAX_TENANT_IDS) break;
        if (!tenantIds.includes(receipt.tenantId)) tenantIds.push(receipt.tenantId);
      }
      reportError(fingerprint, new Error(message), {
        severity: "error",
        integration: "calendly",
        fingerprint,
        staleCount: Math.min(receipts.length, MAX_REPORTED),
        staleCountCapped: receipts.length > MAX_REPORTED,
        oldestAgeMs: now - Math.min(...receipts.map(ageFrom)),
        tenantIds,
      });
    };
    report(
      "pipeline.events_stuck_unprocessed",
      "Calendly webhook receipts queued for over 15 minutes",
      [...queued, ...legacy.filter((receipt) => receipt.receivedAt < cutoff)],
      (receipt) => receipt.queuedAt ?? receipt.receivedAt,
    );
    report(
      "pipeline.deliveries_failed",
      "Calendly webhook receipts failed and require retry",
      failed,
      (receipt) => receipt.receivedAt,
    );
    return null;
  },
});
