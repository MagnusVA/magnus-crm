import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  describeError,
  log,
  reportError,
  type ObsAttributes,
} from "../lib/observability/log";

const CALENDLY_EVENT_TYPE_WEBHOOK_PREFIX = "event_type";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCalendlyEventTypeWebhook(eventType: string) {
  return eventType.startsWith(`${CALENDLY_EVENT_TYPE_WEBHOOK_PREFIX}.`);
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
    const startedAt = Date.now();

    // Load the raw event
    const rawEvent = await ctx.runQuery(internal.pipeline.queries.getRawEvent, {
      rawEventId,
    });

    if (!rawEvent) {
      log.warn("pipeline.event.processed", {
        rawEventId,
        outcome: "raw_event_missing",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const logOutcome = (
      level: "info" | "error",
      outcome: string,
      attrs?: ObsAttributes,
    ) =>
      log[level]("pipeline.event.processed", {
        rawEventId,
        tenantId: rawEvent.tenantId,
        eventType: rawEvent.eventType,
        outcome,
        durationMs: Date.now() - startedAt,
        ...attrs,
      });

    // Idempotency check — skip already-processed events
    if (rawEvent.processed) {
      logOutcome("info", "already_processed");
      return;
    }

    // Parse the payload
    let envelope: unknown;
    try {
      envelope = JSON.parse(rawEvent.payload);
    } catch {
      // Not marked processed, so this event stays unprocessed until someone
      // fixes or deletes it. The SyntaxError message can quote the payload,
      // so report a fixed message instead.
      reportError(
        "pipeline.payload_unparseable",
        new Error("Raw webhook payload is not valid JSON"),
        {
          severity: "error",
          fingerprint: "pipeline.payload_unparseable",
          integration: "calendly",
          rawEventId,
          tenantId: rawEvent.tenantId,
          eventType: rawEvent.eventType,
          outcome: "payload_unparseable",
          durationMs: Date.now() - startedAt,
        },
      );
      return;
    }

    const payload = isRecord(envelope) ? envelope.payload : undefined;
    if (!isRecord(payload)) {
      await ctx.runMutation(internal.pipeline.mutations.markProcessed, {
        rawEventId,
      });
      // Marked processed, so a booking with no payload is lost for good.
      reportError(
        "pipeline.event_dropped",
        new Error(`Calendly ${rawEvent.eventType} event has no payload`),
        {
          severity: "warning",
          fingerprint: `pipeline.event_dropped:${rawEvent.eventType}:missing_payload`,
          integration: "calendly",
          rawEventId,
          tenantId: rawEvent.tenantId,
          eventType: rawEvent.eventType,
          outcome: "skipped",
          reason: "missing_payload",
          durationMs: Date.now() - startedAt,
        },
      );
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
          // Mark as processed to avoid retrying unknown event types
          await ctx.runMutation(internal.pipeline.mutations.markProcessed, {
            rawEventId,
          });
          // The subscription includes event types the pipeline doesn't act
          // on: event_type.* (event types sync manually) and
          // routing_form_submission.created. Skipping them is routine.
          logOutcome("info", "skipped", {
            reason: isCalendlyEventTypeWebhook(rawEvent.eventType)
              ? "event_type_webhook"
              : "unhandled_event_type",
          });
          return;
      }
    } catch (error) {
      // The rethrow fails the action, which the log stream reports.
      logOutcome("error", "failed", { error: describeError(error) });
      // Not marked processed. Nothing retries it automatically: the event
      // stays unprocessed until someone replays it, and the
      // pipeline-stuck-events cron reports it after 15 minutes.
      throw error;
    }

    // Handlers can still skip an event (duplicate, no matching meeting);
    // their own logs record why.
    logOutcome("info", "handled");
  },
});
