import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isPlaceholderEmail, normalizeEmail } from "../lib/normalization";
import { log } from "../lib/observability/log";
import { blockBooking, holdEvidence } from "./blocked";
import { enqueueDelivery } from "./delivery";

/**
 * Held bookings from one email apply oldest first.
 *
 * A later booking applied before an earlier one creates a deal dated after
 * the earlier booking, which then holds as `historical_booking_requires_review`,
 * a hold no admin action clears. The booking Workpool runs several bookings at
 * once, so the order they were queued in is not the order they apply in.
 *
 * A held invitee.created carries `holdKey`, a hash of its tenant and email,
 * until it applies or is ignored. Before identity is resolved, a booking with
 * an earlier keyed receipt still waiting is held as
 * `waiting_for_earlier_booking`. When a keyed booking applies or is ignored,
 * the oldest booking still held under its key is queued again, so a chain of
 * held bookings applies in order once the first one is settled.
 */

export const WAITING_FOR_EARLIER_BOOKING = "waiting_for_earlier_booking";
/**
 * An earlier booking in this hold can't get any worse, so nobody waits on it:
 * the processor drops its key and releases the next booking.
 */
export const HISTORICAL_HOLD = "historical_booking_requires_review";
/** Earlier keyed receipts read; past this, the booking waits (fails closed). */
const EARLIER_LIMIT = 16;

/**
 * The lookup key for a booking email: SHA-256 of the tenant and the
 * normalized email. None for a missing or placeholder email, which never
 * decides identity.
 */
export async function holdKeyFor(
  tenantId: Id<"tenants">,
  email: string | undefined,
): Promise<string | undefined> {
  const normalized = email ? normalizeEmail(email) : undefined;
  if (!normalized || isPlaceholderEmail(normalized)) return undefined;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${tenantId}:${normalized}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Booking order: when it happened, then when it arrived. */
function isBefore(a: Doc<"webhookDeliveries">, b: Doc<"webhookDeliveries">) {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt;
  if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt;
  return a._creationTime < b._creationTime;
}

/** A keyed booking later ones from the same email wait behind. */
function holdsOthersBack(row: Doc<"webhookDeliveries">) {
  return (
    row.eventType === "invitee.created" &&
    (row.status === "queued" ||
      row.status === "failed" ||
      (row.status === "blocked" && row.reason !== HISTORICAL_HOLD))
  );
}

/**
 * The earlier booking from the same email this one has to wait for, if any.
 * `overflow` means too many earlier bookings to read, which counts as waiting.
 */
export async function earlierBookingWaiting(
  ctx: QueryCtx,
  receipt: Doc<"webhookDeliveries">,
  holdKey: string,
): Promise<{ waitingOn?: Id<"webhookDeliveries">; overflow: boolean } | null> {
  // Ties on occurredAt sort by creation time in the index, not by arrival, so
  // equal times are read and ordered here.
  const rows = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_tenantId_and_holdKey_and_occurredAt", (q) =>
      q
        .eq("tenantId", receipt.tenantId)
        .eq("holdKey", holdKey)
        .lte("occurredAt", receipt.occurredAt),
    )
    .take(EARLIER_LIMIT + 2);
  const earlier = rows.filter(
    (row) => row._id !== receipt._id && isBefore(row, receipt),
  );
  if (earlier.length > EARLIER_LIMIT) return { overflow: true };
  const waiting = earlier.find(holdsOthersBack);
  return waiting ? { waitingOn: waiting._id, overflow: false } : null;
}

/**
 * Holds a booking while an earlier booking from the same email is still
 * waiting. Runs inside invitee.created before identity is resolved, so every
 * way a booking is processed obeys it.
 */
export async function holdIfEarlierBookingWaiting(
  ctx: QueryCtx,
  receipt: Doc<"webhookDeliveries"> | null,
  holdKey: string | undefined,
) {
  if (!receipt || !holdKey) return;
  const waiting = await earlierBookingWaiting(ctx, receipt, holdKey);
  if (!waiting) return;
  blockBooking(
    WAITING_FOR_EARLIER_BOOKING,
    undefined,
    holdEvidence(WAITING_FOR_EARLIER_BOOKING, [], {
      truncated: waiting.overflow,
      waitingOnDeliveryId: waiting.waitingOn,
    }),
  );
}

/**
 * Queues the oldest booking still held under `holdKey` once a booking from
 * that email applies or is ignored. Only an apply or an ignore releases, so a
 * released booking that holds again releases nothing and this can't loop.
 */
export async function releaseNextHeldBooking(
  ctx: MutationCtx,
  settled: Doc<"webhookDeliveries">,
  holdKey: string,
) {
  const rows = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_tenantId_and_holdKey_and_occurredAt", (q) =>
      q.eq("tenantId", settled.tenantId).eq("holdKey", holdKey),
    )
    .take(EARLIER_LIMIT + 1);
  const next = rows
    .filter(
      (row) =>
        row._id !== settled._id &&
        row.status === "blocked" &&
        holdsOthersBack(row),
    )
    .sort((a, b) => (isBefore(a, b) ? -1 : 1))[0];
  if (!next) return;
  // A payload past retention can't be processed again; the panel shows it.
  if (!(await ctx.db.get("rawWebhookEvents", next.rawEventId))) return;
  await enqueueDelivery(ctx, next._id);
  log.info("pipeline.held_booking.released", {
    tenantId: settled.tenantId,
    settledDeliveryId: settled._id,
    releasedDeliveryId: next._id,
    releasedReason: next.reason,
  });
}
