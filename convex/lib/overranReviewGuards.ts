import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";

/**
 * Pending-review guard helpers for closer actions on meeting_overran opportunities.
 *
 * v2 replaces the blanket v1 throw-guard with a nuanced gate:
 *   - review pending -> allow action
 *   - review resolved -> reject action
 */
async function findOverranReviewForOpportunity(
  ctx: MutationCtx | QueryCtx,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"meetingReviews"> | null> {
  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId_and_scheduledAt", (q) =>
      q.eq("opportunityId", opportunityId),
    )
    .order("desc")
    .take(20);

  for (const meeting of meetings) {
    if (meeting.reviewId) {
      const linkedReview = await ctx.db.get(meeting.reviewId);
      if (
        linkedReview &&
        linkedReview.category === "meeting_overran" &&
        linkedReview.opportunityId === opportunityId
      ) {
        return linkedReview;
      }
    }

    const fallbackReview = await ctx.db
      .query("meetingReviews")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id))
      .first();
    if (
      fallbackReview &&
      fallbackReview.category === "meeting_overran" &&
      fallbackReview.opportunityId === opportunityId
    ) {
      return fallbackReview;
    }
  }

  return null;
}

export async function assertOverranReviewStillPending(
  ctx: MutationCtx | QueryCtx,
  opportunityId: Id<"opportunities">,
): Promise<void> {
  const review = await findOverranReviewForOpportunity(ctx, opportunityId);
  if (review && review.status === "resolved") {
    throw new Error("This meeting-overran review has already been resolved.");
  }
}

export const getOverranReviewForOpportunity = internalQuery({
  args: { opportunityId: v.id("opportunities") },
  handler: async (ctx, { opportunityId }) => {
    return await findOverranReviewForOpportunity(ctx, opportunityId);
  },
});

export async function assertOverranReviewStillPendingViaQuery(
  ctx: ActionCtx,
  opportunityId: Id<"opportunities">,
): Promise<void> {
  const review: Doc<"meetingReviews"> | null = await ctx.runQuery(
    internal.lib.overranReviewGuards.getOverranReviewForOpportunity,
    { opportunityId },
  );
  if (review && review.status === "resolved") {
    throw new Error("This meeting-overran review has already been resolved.");
  }
}
