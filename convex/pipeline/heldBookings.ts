import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { followMergeChain } from "../leads/identityResolution";
import { LIVE_QUERY_BYTE_BUDGET } from "../lib/liveQueryBounds";
import { normalizePhone } from "../lib/normalization";
import { getString, isRecord } from "../lib/payloadExtraction";
import { requireTenantUser } from "../requireTenantUser";
import { extractHostMembership } from "./bookingHost";
import { holdNextStep, type HoldExplanation } from "./holdNextStep";
import type { IdentityMatchVia } from "./blocked";
import { WAITING_FOR_EARLIER_BOOKING } from "./holdOrder";

/**
 * Held and failed bookings as people read them: who booked, when the call
 * is, the closer, what matched, and the next step in one sentence. For the
 * recovery panel and the Slack post about a held booking that has no review.
 */

const ADMIN_ROLES = ["tenant_master", "tenant_admin"] as const;
const PAGE_LIMIT = 25;
/** People named per row; the hold itself records at most 16. */
const PEOPLE_PER_ROW = 4;

export type HeldBooking = {
  deliveryId: Id<"webhookDeliveries">;
  status: Doc<"webhookDeliveries">["status"];
  reason?: string;
  receivedAt: number;
  occurredAt: number;
  generation: number;
  explanation: HoldExplanation;
  /** False once the payload is past retention: the booking can't be retried. */
  payloadAvailable: boolean;
  inviteeName?: string;
  email?: string;
  phone?: string;
  eventName?: string;
  startTime?: number;
  hostName?: string;
  closerName?: string;
  /** Calendly canceled the booking since it was held. */
  canceledAt?: number;
  reviewId?: Id<"bookingReviews">;
  reviewOpen: boolean;
  waitingOnDeliveryId?: Id<"webhookDeliveries">;
  matches: { leadId: Id<"leads">; name?: string; via: IdentityMatchVia[] }[];
  matchesTruncated: boolean;
};

function parseTime(value: unknown) {
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

/** The booking's own details, from its raw payload while it is retained. */
function readPayload(raw: Doc<"rawWebhookEvents">) {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw.payload);
  } catch {
    return null;
  }
  if (!isRecord(envelope) || !isRecord(envelope.payload)) return null;
  const payload = envelope.payload;
  const event = isRecord(payload.scheduled_event) ? payload.scheduled_event : {};
  const phone = getString(payload, "text_reminder_number");
  return {
    inviteeName: getString(payload, "name"),
    email: getString(payload, "email"),
    phone: phone ? (normalizePhone(phone) ?? phone) : undefined,
    eventName: getString(event, "name"),
    startTime: parseTime(event.start_time),
    host: extractHostMembership(event),
  };
}

/** The closer behind a Calendly host, read only: no hold is thrown here. */
async function closerNameFor(ctx: QueryCtx, tenantId: Id<"tenants">, hostUserUri: string | undefined) {
  if (!hostUserUri) return undefined;
  const direct = await ctx.db
    .query("users")
    .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
      q.eq("tenantId", tenantId).eq("calendlyUserUri", hostUserUri),
    )
    .first();
  const member = direct
    ? null
    : await ctx.db
        .query("calendlyOrgMembers")
        .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
          q.eq("tenantId", tenantId).eq("calendlyUserUri", hostUserUri),
        )
        .first();
  const user = direct ?? (member?.matchedUserId ? await ctx.db.get("users", member.matchedUserId) : null);
  return user?.role === "closer" ? (user.fullName ?? user.email) : undefined;
}

export async function readHeldBooking(
  ctx: QueryCtx,
  receipt: Doc<"webhookDeliveries">,
): Promise<HeldBooking> {
  const raw = await ctx.db.get("rawWebhookEvents", receipt.rawEventId);
  const payload = raw ? readPayload(raw) : null;
  const [review, fact, closerName] = await Promise.all([
    ctx.db
      .query("bookingReviews")
      .withIndex("by_deliveryId", (q) => q.eq("deliveryId", receipt._id))
      .unique(),
    receipt.eventUri
      ? ctx.db
          .query("calendlyBookingFacts")
          .withIndex("by_tenantId_and_eventUri_and_inviteeUri", (q) =>
            q
              .eq("tenantId", receipt.tenantId)
              .eq("eventUri", receipt.eventUri!)
              .eq("inviteeUri", receipt.inviteeUri),
          )
          .first()
      : null,
    closerNameFor(ctx, receipt.tenantId, payload?.host.hostUserUri),
  ]);
  // The hold's own evidence, or the review's people for an older hold.
  const named = receipt.hold?.matches ?? review?.conflicts ?? [];
  const byPerson = new Map<Id<"leads">, IdentityMatchVia[]>();
  for (const match of named)
    byPerson.set(match.leadId, [...(byPerson.get(match.leadId) ?? []), match.via]);
  const matches: HeldBooking["matches"] = [];
  for (const [leadId, via] of [...byPerson].slice(0, PEOPLE_PER_ROW)) {
    const lead = await ctx.db.get("leads", leadId);
    if (!lead || lead.tenantId !== receipt.tenantId) continue;
    const current = (await followMergeChain(ctx, lead)) ?? lead;
    matches.push({ leadId: current._id, name: current.fullName ?? current.email, via });
  }
  return {
    deliveryId: receipt._id,
    status: receipt.status,
    reason: receipt.reason,
    receivedAt: receipt.receivedAt,
    occurredAt: receipt.occurredAt,
    generation: receipt.generation,
    explanation: holdNextStep(receipt.reason),
    payloadAvailable: payload !== null,
    inviteeName: payload?.inviteeName ?? review?.booking.name,
    email: payload?.email ?? review?.booking.email,
    phone: payload?.phone ?? review?.booking.phone,
    eventName: payload?.eventName,
    startTime: payload?.startTime,
    hostName: payload?.host.hostCalendlyName,
    closerName,
    canceledAt: fact?.canceledAt,
    reviewId: review?._id,
    reviewOpen: review?.status === "open",
    waitingOnDeliveryId: receipt.hold?.waitingOnDeliveryId,
    matches,
    matchesTruncated: (receipt.hold?.truncated ?? false) || byPerson.size > PEOPLE_PER_ROW,
  };
}

/**
 * Held or failed bookings, newest first, 25 a page. Bookings whose call is
 * still ahead sort first within the page.
 */
export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.union(v.literal("blocked"), v.literal("failed")),
  },
  handler: async (ctx, { paginationOpts, status }) => {
    const { tenantId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
    const page = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_tenantId_and_status_and_receivedAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", status),
      )
      .order("desc")
      .paginate({
        ...paginationOpts,
        numItems: Math.min(paginationOpts.numItems, PAGE_LIMIT),
        maximumRowsRead: PAGE_LIMIT,
        maximumBytesRead: LIVE_QUERY_BYTE_BUDGET,
      });
    const rows: HeldBooking[] = [];
    for (const receipt of page.page) rows.push(await readHeldBooking(ctx, receipt));
    const now = Date.now();
    const upcoming = (row: HeldBooking) => row.startTime !== undefined && row.startTime >= now;
    rows.sort((a, b) => Number(upcoming(b)) - Number(upcoming(a)));
    return { ...page, page: rows };
  },
});

/** One held booking as its Slack post shows it. */
export const getForAlert = internalQuery({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, { deliveryId }) => {
    const receipt = await ctx.db.get("webhookDeliveries", deliveryId);
    if (!receipt) return null;
    return {
      tenantId: receipt.tenantId,
      heldAlertedAt: receipt.heldAlertedAt,
      booking: await readHeldBooking(ctx, receipt),
    };
  },
});

export const markAlerted = internalMutation({
  args: { deliveryId: v.id("webhookDeliveries") },
  returns: v.null(),
  handler: async (ctx, { deliveryId }) => {
    if (await ctx.db.get("webhookDeliveries", deliveryId))
      await ctx.db.patch("webhookDeliveries", deliveryId, { heldAlertedAt: Date.now() });
    return null;
  },
});

/**
 * Tells Slack about a held booking that has no booking review: a review's
 * own alert covers the rest. Called after the review is settled. A booking
 * waiting behind an earlier one is covered by that one's alert.
 */
export async function scheduleHeldBookingAlert(
  ctx: MutationCtx,
  receipt: Doc<"webhookDeliveries">,
  reason: string,
) {
  if (receipt.eventType !== "invitee.created" || reason === WAITING_FOR_EARLIER_BOOKING) return;
  if (receipt.heldAlertedAt !== undefined) return;
  const review = await ctx.db
    .query("bookingReviews")
    .withIndex("by_deliveryId", (q) => q.eq("deliveryId", receipt._id))
    .unique();
  if (review) return;
  await ctx.scheduler.runAfter(0, internal.slack.heldBookingNotify.post, { deliveryId: receipt._id });
}
