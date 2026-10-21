import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { log } from "../lib/observability/log";
import type {
  BlockedIdentity,
  BookingIdentifiers,
  IdentityConflict,
} from "./blocked";

/** Held reasons that mean "this booking names more than one person". */
const REVIEWED_HOLD_REASONS = new Set(["identity_conflict"]);

/** Earlier reviews of a person read when deciding whether a booking repeats one. */
const PRIOR_REVIEW_LIMIT = 20;

async function reviewForDelivery(
  ctx: MutationCtx,
  deliveryId: Id<"webhookDeliveries">,
) {
  return await ctx.db
    .query("bookingReviews")
    .withIndex("by_deliveryId", (q) => q.eq("deliveryId", deliveryId))
    .unique();
}

function sameConflicts(a: IdentityConflict[], b: IdentityConflict[]) {
  const key = (c: IdentityConflict) => `${c.leadId}:${c.via}`;
  const left = new Set(a.map(key));
  return a.length === b.length && b.every((c) => left.has(key(c)));
}

/**
 * Opens the review for a booking that applied to the person its social handle
 * names while its email or phone names someone else. Called inside
 * invitee.created, so a booking that is blocked later leaves no review. A
 * booking that repeats a pair an admin already kept separate opens none.
 */
export async function recordAttachedReview(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    rawEventId: Id<"rawWebhookEvents">;
    leadId: Id<"leads">;
    conflicts: IdentityConflict[];
    booking: BookingIdentifiers;
    now: number;
  },
) {
  const delivery = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_rawEventId", (q) => q.eq("rawEventId", args.rawEventId))
    .unique();
  if (!delivery) return;

  const prior = await ctx.db
    .query("bookingReviews")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", args.tenantId).eq("leadId", args.leadId),
    )
    .order("desc")
    .take(PRIOR_REVIEW_LIMIT);
  const keptSeparate = prior.some(
    (review) =>
      review.deliveryId !== delivery._id &&
      review.resolution === "kept_separate" &&
      sameConflicts(review.conflicts, args.conflicts),
  );
  if (keptSeparate) {
    log.info("pipeline.booking_review.skipped", {
      reason: "kept_separate_before",
      tenantId: args.tenantId,
      deliveryId: delivery._id,
      leadId: args.leadId,
    });
    return;
  }

  const fields = {
    kind: "attached" as const,
    status: "open" as const,
    reason: undefined,
    leadId: args.leadId,
    conflicts: args.conflicts,
    booking: args.booking,
    updatedAt: args.now,
    resolution: undefined,
    resolvedAt: undefined,
    resolvedByUserId: undefined,
  };
  const existing = await reviewForDelivery(ctx, delivery._id);
  if (existing) {
    // A held booking that now applies is new news, so it alerts again.
    await ctx.db.patch("bookingReviews", existing._id, {
      ...fields,
      alertScheduledAt:
        existing.kind === "attached" ? existing.alertScheduledAt : undefined,
    });
    return;
  }
  await ctx.db.insert("bookingReviews", {
    ...fields,
    tenantId: args.tenantId,
    deliveryId: delivery._id,
    createdAt: args.now,
  });
}

/**
 * Settles a delivery's review once its outcome is known, and schedules the
 * Slack alert the first time a review is open. A held booking whose identity
 * conflict blocks it opens or reopens its review; a held booking that applies
 * closes it.
 */
export async function settleBookingReview(
  ctx: MutationCtx,
  receipt: Doc<"webhookDeliveries">,
  outcome:
    | { status: "blocked"; reason: string; identity?: BlockedIdentity }
    | { status: "applied" | "ignored" },
) {
  const now = Date.now();
  let review = await reviewForDelivery(ctx, receipt._id);

  // A held review needs people to decide between: a block that names one
  // person or none (a phone that doesn't vouch for a new email) is left to
  // the recovery panel.
  const conflicts =
    outcome.status === "blocked"
      ? (outcome.identity?.conflicts ?? review?.conflicts ?? [])
      : [];
  if (
    outcome.status === "blocked" &&
    REVIEWED_HOLD_REASONS.has(outcome.reason) &&
    new Set(conflicts.map((c) => c.leadId)).size > 1
  ) {
    const fields = {
      kind: "held" as const,
      status: "open" as const,
      reason: outcome.reason,
      leadId: undefined,
      conflicts,
      booking: outcome.identity?.booking ?? review?.booking ?? {},
      updatedAt: now,
      resolution: undefined,
      resolvedAt: undefined,
      resolvedByUserId: undefined,
    };
    if (review) {
      const stillOpenHold = review.kind === "held" && review.status === "open";
      await ctx.db.patch("bookingReviews", review._id, {
        ...fields,
        alertScheduledAt: stillOpenHold ? review.alertScheduledAt : undefined,
      });
    } else {
      await ctx.db.insert("bookingReviews", {
        ...fields,
        tenantId: receipt.tenantId,
        deliveryId: receipt._id,
        createdAt: now,
      });
    }
    review = await reviewForDelivery(ctx, receipt._id);
  }
  if (!review) return;

  if (
    outcome.status === "applied" &&
    review.kind === "held" &&
    review.status === "open"
  ) {
    await ctx.db.patch("bookingReviews", review._id, {
      status: "resolved",
      resolution: "booking_applied",
      resolvedAt: now,
      updatedAt: now,
    });
    log.info("pipeline.booking_review.resolved", {
      tenantId: review.tenantId,
      reviewId: review._id,
      deliveryId: receipt._id,
      resolution: "booking_applied",
    });
    return;
  }

  if (review.status === "open" && review.alertScheduledAt === undefined) {
    await ctx.db.patch("bookingReviews", review._id, { alertScheduledAt: now });
    await ctx.scheduler.runAfter(0, internal.slack.bookingReviewNotify.post, {
      reviewId: review._id,
    });
    log.info("pipeline.booking_review.opened", {
      tenantId: review.tenantId,
      reviewId: review._id,
      deliveryId: receipt._id,
      kind: review.kind,
      reason: review.reason,
      conflictCount: review.conflicts.length,
    });
  }
}
