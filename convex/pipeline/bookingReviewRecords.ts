import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { v } from "convex/values";
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { followMergeChain } from "../leads/identityResolution";
import { log } from "../lib/observability/log";
import type {
  BlockedIdentity,
  BookingIdentifiers,
  IdentityConflict,
} from "./blocked";
import { retryDelivery } from "./recovery";

/** Held reasons that mean "this booking names more than one person". */
const REVIEWED_HOLD_REASONS = new Set(["identity_conflict"]);

/** A person's kept-separate decisions read when a booking may repeat one. */
const KEPT_SEPARATE_LIMIT = 200;
/** Open reviews read per page when one decision may settle others. */
const OPEN_REVIEW_SWEEP_LIMIT = 200;

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

  // Only this person's kept-separate decisions, so the bound is never
  // reached by their other reviews.
  const keptSeparateBefore = await ctx.db
    .query("bookingReviews")
    .withIndex("by_tenantId_and_leadId_and_resolution", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("leadId", args.leadId)
        .eq("resolution", "kept_separate"),
    )
    .take(KEPT_SEPARATE_LIMIT);
  const keptSeparate = keptSeparateBefore.some(
    (review) =>
      review.deliveryId !== delivery._id &&
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
  // An admin already called these people different: a retry that finds the
  // same people keeps that decision.
  const keptSeparateUnchanged =
    review?.kind === "held" &&
    review.resolution === "kept_separate" &&
    sameConflicts(review.conflicts, conflicts);
  if (
    outcome.status === "blocked" &&
    !keptSeparateUnchanged &&
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

export async function resolveBookingReview(
  ctx: MutationCtx,
  review: Doc<"bookingReviews">,
  userId: Id<"users">,
  resolution: "merged" | "kept_separate",
) {
  const now = Date.now();
  await ctx.db.patch("bookingReviews", review._id, {
    status: "resolved",
    resolution,
    resolvedAt: now,
    resolvedByUserId: userId,
    updatedAt: now,
  });
  log.info("pipeline.booking_review.resolved", {
    tenantId: review.tenantId,
    reviewId: review._id,
    deliveryId: review.deliveryId,
    kind: review.kind,
    resolution,
  });
}

/**
 * The people a review names as they are now, following merges. `complete`
 * is false when a named person is missing or their merge chain is broken:
 * no decision can be read from such a review.
 */
export async function reviewPeople(
  ctx: QueryCtx,
  review: Doc<"bookingReviews">,
): Promise<{ people: Set<Id<"leads">>; complete: boolean }> {
  const named = new Set([
    ...(review.leadId ? [review.leadId] : []),
    ...review.conflicts.map((c) => c.leadId),
  ]);
  const people = new Set<Id<"leads">>();
  let complete = true;
  for (const leadId of named) {
    const lead = await ctx.db.get("leads", leadId);
    const current = lead && (await followMergeChain(ctx, lead));
    if (current) people.add(current._id);
    else complete = false;
  }
  return { people, complete };
}

/** Every person the review named has been merged into the same one. */
export async function reviewIsOnePerson(
  ctx: QueryCtx,
  review: Doc<"bookingReviews">,
) {
  const { people, complete } = await reviewPeople(ctx, review);
  return complete && people.size === 1;
}

/**
 * Retries a merged review's held booking, which now names one person. A
 * booking whose payload is gone stays held, for the recovery panel.
 */
export async function retryMergedHold(
  ctx: MutationCtx,
  review: Doc<"bookingReviews">,
  userId: Id<"users">,
) {
  if (review.kind !== "held") return;
  const delivery = await ctx.db.get("webhookDeliveries", review.deliveryId);
  if (delivery?.status !== "blocked") return;
  if (!(await ctx.db.get("rawWebhookEvents", delivery.rawEventId))) return;
  await retryDelivery(ctx, review.tenantId, userId, delivery._id);
}

/**
 * A page of the tenant's open reviews. A sweep past the page continues in a
 * scheduled mutation of its own, so a long queue never outgrows one
 * transaction.
 */
async function openReviewsPage(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  cursor: string | null,
) {
  return await ctx.db
    .query("bookingReviews")
    .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
      q.eq("tenantId", tenantId).eq("status", "open"),
    )
    .paginate({ cursor, numItems: OPEN_REVIEW_SWEEP_LIMIT });
}

/**
 * Closes, as merged, every open review a merge left with one person: the
 * same people often book twice, and a merge from either review, or from the
 * Leads page, settles both. Their held bookings are retried. Returns how many
 * closed on this page; later pages close in the background.
 */
export async function closeMergedReviews(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  userId: Id<"users">,
  cursor: string | null = null,
) {
  const page = await openReviewsPage(ctx, tenantId, cursor);
  let closed = 0;
  for (const review of page.page) {
    if (!(await reviewIsOnePerson(ctx, review))) continue;
    await resolveBookingReview(ctx, review, userId, "merged");
    await retryMergedHold(ctx, review, userId);
    closed++;
  }
  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.pipeline.bookingReviewRecords.continueMergedSweep, {
      tenantId,
      userId,
      cursor: page.continueCursor,
    });
    log.info("pipeline.booking_review.sweep_continued", { tenantId, sweep: "merged" });
  }
  return closed;
}

export const continueMergedSweep = internalMutation({
  args: { tenantId: v.id("tenants"), userId: v.id("users"), cursor: v.string() },
  returns: v.null(),
  handler: async (ctx, { tenantId, userId, cursor }) => {
    await closeMergedReviews(ctx, tenantId, userId, cursor);
    return null;
  },
});

/**
 * Closes, as kept separate, the other open reviews about exactly the people
 * an admin just called different. Only a decision about two or more people
 * who all still exist carries over. Returns how many closed on this page;
 * later pages close in the background.
 */
export async function closeKeptSeparateSiblings(
  ctx: MutationCtx,
  decided: Doc<"bookingReviews">,
  userId: Id<"users">,
  cursor: string | null = null,
) {
  const keyOf = async (review: Doc<"bookingReviews">) => {
    const { people, complete } = await reviewPeople(ctx, review);
    return complete && people.size > 1 ? [...people].sort().join(",") : null;
  };
  const decidedKey = await keyOf(decided);
  if (decidedKey === null) return 0;
  const page = await openReviewsPage(ctx, decided.tenantId, cursor);
  let closed = 0;
  for (const review of page.page) {
    if (review._id === decided._id) continue;
    if ((await keyOf(review)) !== decidedKey) continue;
    await resolveBookingReview(ctx, review, userId, "kept_separate");
    closed++;
  }
  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.pipeline.bookingReviewRecords.continueKeptSeparateSweep, {
      reviewId: decided._id,
      userId,
      cursor: page.continueCursor,
    });
    log.info("pipeline.booking_review.sweep_continued", {
      tenantId: decided.tenantId,
      sweep: "kept_separate",
    });
  }
  return closed;
}

export const continueKeptSeparateSweep = internalMutation({
  args: { reviewId: v.id("bookingReviews"), userId: v.id("users"), cursor: v.string() },
  returns: v.null(),
  handler: async (ctx, { reviewId, userId, cursor }) => {
    const decided = await ctx.db.get("bookingReviews", reviewId);
    if (decided) await closeKeptSeparateSiblings(ctx, decided, userId, cursor);
    return null;
  },
});
