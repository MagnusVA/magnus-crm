import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getString, isRecord } from "../lib/payloadExtraction";
import { ignoreBooking } from "./blocked";
import { log } from "../lib/observability/log";

/**
 * The pipeline tracks closers' sales calls, which are one invitee per
 * scheduled event. A Calendly group event (many invitees share one scheduled
 * event) is never a sales call, whoever hosts it.
 *
 * The scheduled event's `invitees_counter.limit` decides: it is required on
 * every invitee payload (created, canceled, and no-show alike), describes the
 * booked event itself, and doesn't depend on the event type sync. A one-on-one
 * event has a limit of 1, including round robin and collective team events.
 * The synced event type's `calendlyKind` is only a fallback for a payload
 * without the counter; an event type that was never synced counts as
 * one-on-one.
 */
export async function isGroupEvent(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  scheduledEvent: Record<string, unknown>,
) {
  const counter = scheduledEvent.invitees_counter;
  if (isRecord(counter) && typeof counter.limit === "number")
    return counter.limit > 1;
  const eventTypeUri = getString(scheduledEvent, "event_type");
  if (!eventTypeUri) return false;
  const config = await ctx.db
    .query("eventTypeConfigs")
    .withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
      q.eq("tenantId", tenantId).eq("calendlyEventTypeUri", eventTypeUri),
    )
    .first();
  return config?.calendlyKind === "group";
}

/**
 * Ignores any invitee delivery (invitee.created or a follow-up) of a group
 * event as `group_event`, before host or identity resolution, so it writes
 * nothing. The one exception is an invitee that already owns the scheduled
 * event's meeting: group events used to be tracked, and that registrant's
 * cancellations and no-shows keep its existing meeting consistent.
 */
export async function ignoreGroupEventDelivery(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    rawEventId: Id<"rawWebhookEvents">;
    eventType: string;
    eventUri: string;
    inviteeUri: string;
    payload: unknown;
  },
) {
  const scheduledEvent =
    isRecord(args.payload) && isRecord(args.payload.scheduled_event)
      ? args.payload.scheduled_event
      : {};
  if (!(await isGroupEvent(ctx, args.tenantId, scheduledEvent))) return;
  const meeting = await ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
      q.eq("tenantId", args.tenantId).eq("calendlyEventUri", args.eventUri),
    )
    .first();
  if (meeting?.calendlyInviteeUri === args.inviteeUri) return;
  log.info("pipeline.booking.skipped", {
    reason: "group_event",
    eventType: args.eventType,
    tenantId: args.tenantId,
    rawEventId: args.rawEventId,
    meetingId: meeting?._id,
  });
  ignoreBooking("group_event");
}
