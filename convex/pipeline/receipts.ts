import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getString, isRecord } from "../lib/payloadExtraction";
import { recordBookingFact } from "./bookingFacts";

export async function deliveryMetadata(
  raw: Pick<
    Doc<"rawWebhookEvents">,
    "payload" | "eventType" | "calendlyEventUri" | "receivedAt"
  >,
) {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw.payload);
  } catch {
    envelope = null;
  }
  const timestamp = isRecord(envelope)
    ? getString(envelope, "created_at")
    : undefined;
  const parsed = timestamp ? Date.parse(timestamp) : NaN;
  const occurredAt = Number.isFinite(parsed) ? parsed : raw.receivedAt;
  const payload =
    isRecord(envelope) && isRecord(envelope.payload) ? envelope.payload : null;
  const scheduled =
    payload && isRecord(payload.scheduled_event)
      ? payload.scheduled_event
      : null;
  const eventUri =
    (scheduled ? getString(scheduled, "uri") : undefined) ??
    (payload ? getString(payload, "event") : undefined);
  const immutable =
    raw.eventType === "invitee.created" || raw.eventType === "invitee.canceled";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        raw.eventType,
        raw.calendlyEventUri,
        immutable ? null : (timestamp ?? raw.payload),
      ]),
    ),
  );
  const key = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return { key, occurredAt, payload, eventUri };
}

/** Adoption never replays a historical event or trusts processed=true as proof of success. */
export async function adoptRawDelivery(
  ctx: MutationCtx,
  raw: Doc<"rawWebhookEvents">,
) {
  const metadata = await deliveryMetadata(raw);
  const existing = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_tenantId_and_key", (q) =>
      q.eq("tenantId", raw.tenantId).eq("key", metadata.key),
    )
    .unique();
  if (existing) {
    // Keep one retained payload per logical delivery. An alias must not become
    // another permanently "stuck" event after migration.
    if (
      existing.rawEventId !== raw._id &&
      (await ctx.db.get("rawWebhookEvents", existing.rawEventId))
    ) {
      await ctx.db.patch("rawWebhookEvents", raw._id, {
        processed: true,
        processingReason: "duplicate_delivery",
      });
    }
    return existing;
  }
  await recordBookingFact(ctx, {
    tenantId: raw.tenantId,
    eventType: raw.eventType,
    eventUri: metadata.eventUri,
    inviteeUri: raw.calendlyEventUri,
    occurredAt: metadata.occurredAt,
    payload: metadata.payload,
  });
  const meeting = metadata.eventUri
    ? await ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
          q
            .eq("tenantId", raw.tenantId)
            .eq("calendlyEventUri", metadata.eventUri!),
        )
        .unique()
    : null;
  const unsupported = ![
    "invitee.created",
    "invitee.canceled",
    "invitee_no_show.created",
    "invitee_no_show.deleted",
  ].includes(raw.eventType);
  const applied =
    raw.processed && meeting?.calendlyInviteeUri === raw.calendlyEventUri;
  const id = await ctx.db.insert("webhookDeliveries", {
    tenantId: raw.tenantId,
    key: metadata.key,
    occurredAt: metadata.occurredAt,
    eventUri: metadata.eventUri,
    eventType: raw.eventType,
    inviteeUri: raw.calendlyEventUri,
    rawEventId: raw._id,
    receivedAt: raw.receivedAt,
    status: unsupported ? "ignored" : applied ? "applied" : "blocked",
    reason: unsupported
      ? "unsupported_event_type"
      : applied
        ? undefined
        : "legacy_delivery_requires_review",
    generation: 0,
    meetingId: applied ? meeting._id : undefined,
  });
  await ctx.db.patch("rawWebhookEvents", raw._id, {
    occurredAt: metadata.occurredAt,
    processed: Boolean(applied || unsupported),
  });
  return (await ctx.db.get("webhookDeliveries", id))!;
}
