import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

/**
 * PR #91 reached production at this time. Deliveries blocked before it were
 * classified by the old pipeline, so they are dismissed in bulk; anything
 * blocked later is a fresh signal and stays in the review queue.
 */
export const DISMISS_BLOCKED_BEFORE = Date.parse("2026-10-14T06:27:20Z");
export const DISMISSED_REASON = "dismissed_backlog";
const MAX_PREVIEW = 1000;
const MAX_RESTORE = 100;

export function isDismissible(row: Doc<"webhookDeliveries">) {
  return row.status === "blocked" && row.receivedAt < DISMISS_BLOCKED_BEFORE;
}

/**
 * Marks a blocked delivery ignored and its raw event processed, which stops the
 * stuck-event alerts. Raw cleanup then treats the payload as resolved and
 * deletes it once it is older than the 30-day retention window.
 */
export async function dismissBlockedDelivery(
  ctx: MutationCtx,
  row: Doc<"webhookDeliveries">,
) {
  if (!isDismissible(row)) return false;
  const now = Date.now();
  await ctx.db.insert("webhookDeliveryDismissals", {
    tenantId: row.tenantId,
    deliveryId: row._id,
    dismissedAt: now,
    previousGeneration: row.generation,
    previousStatus: row.status,
    previousReason: row.reason,
  });
  // A new generation turns any stale Workpool job for this delivery into a no-op.
  await ctx.db.patch("webhookDeliveries", row._id, {
    status: "ignored",
    reason: DISMISSED_REASON,
    generation: row.generation + 1,
    processedAt: now,
    workId: undefined,
  });
  const raw = await ctx.db.get("rawWebhookEvents", row.rawEventId);
  if (raw)
    await ctx.db.patch("rawWebhookEvents", raw._id, {
      processed: true,
      processingReason: DISMISSED_REASON,
    });
  return true;
}

/** Read-only count of what `migrations:dismissBlockedBacklog` would change. */
export const previewBlockedBacklogDismissal = internalQuery({
  args: {},
  returns: v.object({
    toDismiss: v.number(),
    capped: v.boolean(),
    rawPayloadsMissing: v.number(),
    byReason: v.array(v.object({ reason: v.string(), count: v.number() })),
    blockedAfterCutoff: v.number(),
  }),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_status_and_receivedAt", (q) =>
        q.eq("status", "blocked").lt("receivedAt", DISMISS_BLOCKED_BEFORE),
      )
      .take(MAX_PREVIEW + 1);
    const counted = rows.slice(0, MAX_PREVIEW);
    const byReason = new Map<string, number>();
    let rawPayloadsMissing = 0;
    for (const row of counted) {
      const reason = row.reason ?? "(none)";
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
      if (!(await ctx.db.get("rawWebhookEvents", row.rawEventId)))
        rawPayloadsMissing++;
    }
    const after = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_status_and_receivedAt", (q) =>
        q.eq("status", "blocked").gte("receivedAt", DISMISS_BLOCKED_BEFORE),
      )
      .take(MAX_PREVIEW);
    return {
      toDismiss: counted.length,
      capped: rows.length > MAX_PREVIEW,
      rawPayloadsMissing,
      byReason: [...byReason]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      blockedAfterCutoff: after.length,
    };
  },
});

/**
 * Undo for selected dismissed deliveries: restores the logged status and
 * reason so they show up in pipeline recovery again. A delivery whose raw
 * payload was already cleaned up is restored but can no longer be retried.
 */
export const restoreDismissedDeliveries = internalMutation({
  args: { deliveryIds: v.array(v.id("webhookDeliveries")) },
  returns: v.object({ restored: v.number(), skipped: v.number() }),
  handler: async (ctx, { deliveryIds }) => {
    if (deliveryIds.length > MAX_RESTORE)
      throw new Error(`Restore at most ${MAX_RESTORE} deliveries per call`);
    const now = Date.now();
    let restored = 0;
    for (const deliveryId of new Set(deliveryIds)) {
      const row = await ctx.db.get("webhookDeliveries", deliveryId);
      const log = await ctx.db
        .query("webhookDeliveryDismissals")
        .withIndex("by_deliveryId", (q) => q.eq("deliveryId", deliveryId))
        .order("desc")
        .first();
      if (
        !row ||
        !log ||
        log.restoredAt !== undefined ||
        row.status !== "ignored" ||
        row.reason !== DISMISSED_REASON
      )
        continue;
      await ctx.db.patch("webhookDeliveries", row._id, {
        status: log.previousStatus,
        reason: log.previousReason,
        generation: row.generation + 1,
        processedAt: now,
      });
      const raw = await ctx.db.get("rawWebhookEvents", row.rawEventId);
      if (raw)
        await ctx.db.patch("rawWebhookEvents", raw._id, {
          processed: false,
          processingReason: undefined,
        });
      await ctx.db.patch("webhookDeliveryDismissals", log._id, {
        restoredAt: now,
      });
      restored++;
    }
    return { restored, skipped: new Set(deliveryIds).size - restored };
  },
});
