import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Main pipeline dispatcher.
 *
 * Reads a raw webhook event, parses the JSON payload, and dispatches
 * to the appropriate handler based on event type.
 *
 * Triggered by: ctx.scheduler.runAfter(0, internal.pipeline.processor.processRawEvent, { rawEventId })
 * This is called from the webhook ingestion handler in convex/webhooks/calendly.ts.
 *
 * Idempotent: if the event is already processed, this is a no-op.
 */
export const processRawEvent = internalAction({
  args: { rawEventId: v.id("rawWebhookEvents") },
  handler: async (ctx, { rawEventId }) => {
    // Load the raw event
    const rawEvent = await ctx.runQuery(internal.pipeline.queries.getRawEvent, {
      rawEventId,
    });

    if (!rawEvent) {
      console.error(`[Pipeline] Raw event ${rawEventId} not found`);
      return;
    }

    // Idempotency check — skip already-processed events
    if (rawEvent.processed) {
      console.log(`[Pipeline] Event ${rawEventId} already processed, skipping`);
      return;
    }

    // Parse the payload
    let envelope: unknown;
    try {
      envelope = JSON.parse(rawEvent.payload);
    } catch (e) {
      console.error(`[Pipeline] Failed to parse payload for event ${rawEventId}:`, e);
      return;
    }

    const payload = isRecord(envelope) ? envelope.payload : undefined;
    if (!isRecord(payload)) {
      console.error(
        `[Pipeline] Missing nested payload object for event ${rawEventId} (type: ${rawEvent.eventType})`,
      );
      await ctx.runMutation(internal.pipeline.mutations.markProcessed, {
        rawEventId,
      });
      return;
    }

    // Dispatch to the appropriate handler
    try {
      switch (rawEvent.eventType) {
        case "invitee.created":
          await ctx.runMutation(internal.pipeline.inviteeCreated.process, {
            tenantId: rawEvent.tenantId,
            payload,
            rawEventId,
          });
          break;

        case "invitee.canceled":
          await ctx.runMutation(internal.pipeline.inviteeCanceled.process, {
            tenantId: rawEvent.tenantId,
            payload,
            rawEventId,
          });
          break;

        case "invitee_no_show.created":
          await ctx.runMutation(internal.pipeline.inviteeNoShow.process, {
            tenantId: rawEvent.tenantId,
            payload,
            rawEventId,
          });
          break;

        case "invitee_no_show.deleted":
          // No-show reversal: revert meeting/opportunity back to scheduled
          await ctx.runMutation(internal.pipeline.inviteeNoShow.revert, {
            tenantId: rawEvent.tenantId,
            payload,
            rawEventId,
          });
          break;

        default:
          console.log(
            `[Pipeline] Unhandled event type "${rawEvent.eventType}" for event ${rawEventId}`
          );
          // Mark as processed to avoid retrying unknown event types
          await ctx.runMutation(internal.pipeline.mutations.markProcessed, {
            rawEventId,
          });
      }
    } catch (error) {
      console.error(
        `[Pipeline] Error processing event ${rawEventId} (type: ${rawEvent.eventType}):`,
        error
      );
      // Do NOT mark as processed — the event will be retried on next run
      throw error;
    }
  },
});
