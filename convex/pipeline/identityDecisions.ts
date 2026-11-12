import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import {
  followMergeChain,
  isPlaceholderPollutedLead,
} from "../leads/identityResolution";
import { log } from "../lib/observability/log";
import { getString, isRecord } from "../lib/payloadExtraction";
import { requireTenantUser } from "../requireTenantUser";
import {
  closeKeptSeparateSiblings,
  PHONE_MATCH_NEW_EMAIL,
  resolveBookingReview,
} from "./bookingReviewRecords";
import { earlierBookingWaiting } from "./holdOrder";
import { retryDelivery } from "./recovery";

/**
 * "Is this the same person?" and the held two-person review's "Different
 * people". An answer is stored in `bookingIdentityDecisions`, which the
 * identity resolver reads for this booking and for later bookings with the
 * same email; the booking is then retried and applies through the normal
 * pipeline. Nothing about a person changes when an answer is given: "Same
 * person" adds the email as the person's identifier when the booking applies.
 */

const ADMIN_ROLES = ["tenant_master", "tenant_admin"] as const;
type Answer = Doc<"bookingIdentityDecisions">["decision"];

const ANSWER_WORDS: Record<Answer, string> = {
  same_person: "Same person",
  different_person: "Different person",
};

/** The deal a CRM booking link names, when the booking came from one. */
async function bookingLinkTarget(
  ctx: QueryCtx,
  raw: Doc<"rawWebhookEvents">,
): Promise<Doc<"opportunities"> | "unknown" | null> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw.payload);
  } catch {
    return null;
  }
  const payload = isRecord(envelope) && isRecord(envelope.payload) ? envelope.payload : {};
  const tracking = isRecord(payload.tracking) ? payload.tracking : {};
  const campaign = getString(tracking, "utm_campaign");
  if (getString(tracking, "utm_source") !== "ptdom" || !campaign) return null;
  const id = ctx.db.normalizeId("opportunities", campaign);
  const deal = id ? await ctx.db.get("opportunities", id) : null;
  return deal && deal.tenantId === raw.tenantId ? deal : "unknown";
}

/** Who a held booking's review decides about, as they are now, and why it can or can't be decided. */
export type HeldBookingState = {
  delivery: Doc<"webhookDeliveries"> | null;
  payloadAvailable: boolean;
  /** The earlier booking from the same email this one waits behind. */
  waitingOn?: Id<"webhookDeliveries">;
  /** The deal the booking link names, for a booking made through a CRM link. */
  linkDealLeadId?: Id<"leads"> | "unknown";
};

export async function readHeldBookingState(
  ctx: QueryCtx,
  review: Doc<"bookingReviews">,
): Promise<HeldBookingState> {
  const delivery = await ctx.db.get("webhookDeliveries", review.deliveryId);
  const raw = delivery ? await ctx.db.get("rawWebhookEvents", delivery.rawEventId) : null;
  const waiting =
    delivery?.holdKey ? await earlierBookingWaiting(ctx, delivery, delivery.holdKey) : null;
  const link = raw ? await bookingLinkTarget(ctx, raw) : null;
  let linkDealLeadId: HeldBookingState["linkDealLeadId"];
  if (link === "unknown") linkDealLeadId = "unknown";
  else if (link) {
    const lead = await ctx.db.get("leads", link.leadId);
    linkDealLeadId = (lead && (await followMergeChain(ctx, lead)))?._id ?? "unknown";
  }
  return {
    delivery,
    payloadAvailable: raw !== null,
    ...(waiting && { waitingOn: waiting.waitingOn }),
    ...(linkDealLeadId && { linkDealLeadId }),
  };
}

/** Refuses an answer the held booking can't act on yet. */
function requireActionable(state: HeldBookingState, reason?: string) {
  const { delivery } = state;
  if (!delivery) throw new Error("This booking's delivery no longer exists");
  if (delivery.status === "queued")
    throw new Error("This booking is being processed. Try again in a moment.");
  if (delivery.status !== "blocked")
    throw new Error("This booking isn't held anymore");
  if (!state.payloadAvailable)
    throw new Error("The booking's original data is gone, so it can't be applied from here");
  if (state.waitingOn)
    throw new Error("An earlier booking from this person is waiting. Decide that one first.");
  if (reason && delivery.reason !== reason)
    throw new Error("This booking is now held for another reason. Check it in Booked Calls → Diagnostics.");
  return delivery;
}

/** The current person behind a lead ID the review named. */
async function currentPerson(ctx: QueryCtx, tenantId: Id<"tenants">, leadId: Id<"leads">) {
  const lead = await ctx.db.get("leads", leadId);
  if (!lead || lead.tenantId !== tenantId) return undefined;
  return await followMergeChain(ctx, lead);
}

/** Someone other than `leadId` holds this email, as a main email or an identifier. */
async function emailHeldByAnother(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  email: string,
  leadId: Id<"leads">,
) {
  const [identifiers, legacy] = await Promise.all([
    ctx.db
      .query("leadIdentifiers")
      .withIndex("by_tenantId_and_type_and_value", (q) =>
        q.eq("tenantId", tenantId).eq("type", "email").eq("value", email),
      )
      .take(8),
    ctx.db
      .query("leads")
      .withIndex("by_tenantId_and_email", (q) => q.eq("tenantId", tenantId).eq("email", email))
      .take(8),
  ]);
  const holders = [
    ...legacy,
    ...(await Promise.all(identifiers.map((i) => ctx.db.get("leads", i.leadId)))),
  ];
  for (const holder of holders) {
    if (!holder) continue;
    const current = await followMergeChain(ctx, holder);
    if (current?._id !== leadId) return true;
  }
  return false;
}

/**
 * Stores an answer about the booking's email and a person: one per email and
 * person, or per delivery when the email is a placeholder. The same answer
 * given twice is reused; the opposite one is refused. Reading the key's range
 * first makes two concurrent answers for one key conflict.
 */
async function recordAnswer(
  ctx: MutationCtx,
  args: {
    review: Doc<"bookingReviews">;
    leadId: Id<"leads">;
    decision: Answer;
    userId: Id<"users">;
  },
) {
  const { review, leadId, decision } = args;
  const email = review.booking.email;
  const existing = email
    ? await ctx.db
        .query("bookingIdentityDecisions")
        .withIndex("by_tenantId_and_email_and_leadId", (q) =>
          q.eq("tenantId", review.tenantId).eq("email", email).eq("leadId", leadId),
        )
        .take(1)
    : (
        await ctx.db
          .query("bookingIdentityDecisions")
          .withIndex("by_deliveryId", (q) => q.eq("deliveryId", review.deliveryId))
          .take(16)
      ).filter((row) => row.leadId === leadId);
  const earlier = existing[0];
  if (earlier) {
    if (earlier.decision === decision) return;
    throw new Error(
      `This email was already answered as "${ANSWER_WORDS[earlier.decision]}" on ${new Date(earlier.decidedAt).toISOString().slice(0, 10)}.`,
    );
  }
  await ctx.db.insert("bookingIdentityDecisions", {
    tenantId: review.tenantId,
    ...(email ? { email } : { deliveryId: review.deliveryId }),
    leadId,
    decision,
    reviewId: review._id,
    decidedByUserId: args.userId,
    decidedAt: Date.now(),
  });
}

async function requireReview(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  reviewId: Id<"bookingReviews">,
) {
  const review = await ctx.db.get("bookingReviews", reviewId);
  if (!review || review.tenantId !== tenantId) throw new Error("Booking review not found");
  if (review.status !== "open") throw new Error("This booking review is already resolved");
  return review;
}

/**
 * Answers "Is this the same person?". "Same person": the booking applies to
 * the person its phone names, and its email becomes theirs. "Different
 * person": the booking gets a new person with the email and no phone; the
 * phone stays where it is. Either way the answer is remembered for later
 * bookings with this email, and the booking is retried now.
 */
export const decideIdentityCheck = mutation({
  args: {
    reviewId: v.id("bookingReviews"),
    decision: v.union(v.literal("same_person"), v.literal("different_person")),
  },
  returns: v.null(),
  handler: async (ctx, { reviewId, decision }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
    const review = await requireReview(ctx, tenantId, reviewId);
    if (review.kind !== "identity_check")
      throw new Error("This review isn't a same-person check");
    const state = await readHeldBookingState(ctx, review);
    const delivery = requireActionable(state, PHONE_MATCH_NEW_EMAIL);
    const named = review.conflicts[0]?.leadId;
    const person = named && (await currentPerson(ctx, tenantId, named));
    if (!person)
      throw new Error("The person this booking matched no longer exists. Check them on the Leads page.");
    if (state.linkDealLeadId) {
      if (decision === "different_person")
        throw new Error("This booking came from a CRM booking link, so it can't go to a new person. An operator has to place it.");
      if (state.linkDealLeadId !== person._id)
        throw new Error("The booking link belongs to another person's deal. An operator has to place this booking.");
    }
    if (decision === "same_person") {
      if (review.booking.email && (await emailHeldByAnother(ctx, tenantId, review.booking.email, person._id)))
        throw new Error("This email now belongs to another person. Use Check again to see who.");
      if (await isPlaceholderPollutedLead(ctx, person._id))
        throw new Error("This person's record mixes details from several people. Fix it on the Leads page first.");
    }
    await recordAnswer(ctx, { review, leadId: person._id, decision, userId });
    await resolveBookingReview(ctx, review, userId, decision);
    await retryDelivery(ctx, tenantId, userId, delivery._id);
    log.info("pipeline.booking_review.identity_decided", {
      tenantId,
      reviewId,
      deliveryId: delivery._id,
      leadId: person._id,
      decision,
    });
    return null;
  },
});

/**
 * The person a held two-person review's "Different people" books the call
 * for: the one who owns the booking's email, when the other person matched by
 * phone only. Undefined for any other shape, which needs a merge or a fix.
 */
export async function emailOwnerOfHeldReview(
  ctx: QueryCtx,
  review: Doc<"bookingReviews">,
): Promise<{ emailOwner: Id<"leads">; phoneOwner: Id<"leads"> } | undefined> {
  if (review.kind !== "held" || !review.booking.email) return undefined;
  if (review.conflicts.some((c) => c.via === "social_handle")) return undefined;
  const byVia = async (via: "email" | "phone") => {
    const ids = new Set<Id<"leads">>();
    for (const c of review.conflicts.filter((c) => c.via === via)) {
      const person = await currentPerson(ctx, review.tenantId, c.leadId);
      if (!person) return undefined;
      ids.add(person._id);
    }
    return ids;
  };
  const [email, phone] = [await byVia("email"), await byVia("phone")];
  if (!email || !phone || email.size !== 1 || phone.size !== 1) return undefined;
  const [emailOwner] = email;
  const [phoneOwner] = phone;
  return emailOwner === phoneOwner ? undefined : { emailOwner, phoneOwner };
}

/**
 * "Different people: book this call for {email owner}" on a held review. The
 * phone's person keeps the phone, the answer is remembered, and the booking
 * is retried for the email's person. Other held shapes are refused.
 */
export async function bookHeldForEmailOwner(
  ctx: MutationCtx,
  review: Doc<"bookingReviews">,
  userId: Id<"users">,
) {
  const shape = await emailOwnerOfHeldReview(ctx, review);
  if (!shape)
    throw new Error(
      "These people can't be kept separate from here. Merge them, or fix who holds the email or phone on the Leads page, then retry.",
    );
  const state = await readHeldBookingState(ctx, review);
  const delivery = requireActionable(state);
  if (state.linkDealLeadId)
    throw new Error("This booking came from a CRM booking link. An operator has to place it.");
  if (await isPlaceholderPollutedLead(ctx, shape.emailOwner))
    throw new Error("The email's person mixes details from several people. Fix them on the Leads page first.");
  await recordAnswer(ctx, { review, leadId: shape.phoneOwner, decision: "different_person", userId });
  await resolveBookingReview(ctx, review, userId, "kept_separate");
  const alsoClosed = await closeKeptSeparateSiblings(ctx, review, userId);
  await retryDelivery(ctx, review.tenantId, userId, delivery._id);
  return { alsoClosed };
}
