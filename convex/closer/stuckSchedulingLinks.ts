import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { loadFollowedMeeting } from "../lib/followedMeeting";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import { transitionOpportunity } from "../lib/opportunityActivity";
import { awaitsCallResult } from "../opportunities/dealGuards";

// Before 2026-10-29 generating a scheduling link left the deal where it was
// until the closer pressed Done, and a dialog closed some other way could
// leave the link pending on a deal still at Booked or Call held. Generating
// a link now moves the deal to Follow-up at once; the one-off backfill in
// `convex/migrations.ts` (`moveStuckSchedulingLinksToFollowUp`, with its
// preview and assert) moves those deals.
//
// The old flow could also leave two pending links on one deal: a booking
// through one marks only that one booked and moves the deal to Booked, and
// the other stays pending. That deal was rebooked for real, so its leftover
// link is superseded: the backfill expires the link and leaves the deal.

/** How many of the deal's newest meetings the superseded check reads. */
const NEWEST_MEETINGS_SCAN = 10;
/** How many of the deal's booked follow-ups the superseded check reads. */
const BOOKED_FOLLOW_UPS_SCAN = 20;

/**
 * A candidate: a pending scheduling link whose deal is still open at Booked
 * or Call held. A deal at Follow-up already, or a closed one (a no-show or
 * loss after the link), isn't one. Null otherwise.
 */
export async function stuckLinkDeal(
  ctx: QueryCtx | MutationCtx,
  followUp: Doc<"followUps">,
): Promise<Doc<"opportunities"> | null> {
  if (followUp.type !== "scheduling_link" || followUp.status !== "pending") {
    return null;
  }
  const deal = await ctx.db.get("opportunities", followUp.opportunityId);
  if (!deal || deal.tenantId !== followUp.tenantId) {
    return null;
  }
  return awaitsCallResult(deal) ? deal : null;
}

export type SupersededReason = "booked_follow_up" | "later_meeting" | "upcoming_meeting";

/**
 * Whether the deal moved on after the link was sent, so the link is dead and
 * the deal must stay where it is: another of its follow-ups was booked after
 * the link, it has a meeting created after the link, or it has a call still
 * to come other than the one the link followed (`sourceMeetingId`: a link
 * generated in the early-outcome window, before its own call starts, is
 * still stuck). Bounded indexed reads. Null when none of these happened.
 */
export async function supersededBy(
  ctx: QueryCtx | MutationCtx,
  followUp: Doc<"followUps">,
  now: number,
  sourceMeetingId: Id<"meetings"> | null = null,
): Promise<SupersededReason | null> {
  const booked = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q.eq("opportunityId", followUp.opportunityId).eq("status", "booked"),
    )
    .take(BOOKED_FOLLOW_UPS_SCAN);
  if (
    booked.some(
      (other) =>
        other._id !== followUp._id && (other.bookedAt ?? other.createdAt) > followUp.createdAt,
    )
  ) {
    return "booked_follow_up";
  }

  const newest = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", followUp.opportunityId))
    .order("desc")
    .take(NEWEST_MEETINGS_SCAN);
  if (newest.some((meeting) => meeting.createdAt > followUp.createdAt)) {
    return "later_meeting";
  }

  // Two rows: the link's own call may be one of them.
  const upcoming = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId_and_status_and_scheduledAt", (q) =>
      q.eq("opportunityId", followUp.opportunityId).eq("status", "scheduled").gt("scheduledAt", now),
    )
    .take(2);
  return upcoming.some((meeting) => meeting._id !== sourceMeetingId) ? "upcoming_meeting" : null;
}

/** Whether the backfill marks `meeting` held: only a call nobody recorded yet. */
export function marksMeetingHeld(meeting: Doc<"meetings"> | null): meeting is Doc<"meetings"> {
  return meeting !== null && meeting.status === "scheduled";
}

export type StuckLinkPlan =
  | {
      kind: "superseded";
      deal: Doc<"opportunities">;
      reason: SupersededReason;
    }
  | {
      kind: "move";
      deal: Doc<"opportunities">;
      /** The call the link followed (lib/followedMeeting.ts), or null. */
      followedMeeting: Doc<"meetings"> | null;
      /** That call, when it is still unrecorded and the backfill marks it held. */
      heldMeetingId: Id<"meetings"> | null;
    };

/** What the backfill does with a follow-up: nothing (null), expire it, or move its deal. */
export async function planStuckLink(
  ctx: QueryCtx | MutationCtx,
  followUp: Doc<"followUps">,
  now: number,
): Promise<StuckLinkPlan | null> {
  const deal = await stuckLinkDeal(ctx, followUp);
  if (!deal) return null;
  // The call the link followed first, so its own call (still to come when
  // the link was generated early) doesn't count as a later booking.
  const followedMeeting = await loadFollowedMeeting(ctx, followUp);
  const reason = await supersededBy(ctx, followUp, now, followedMeeting?._id ?? null);
  if (reason) return { kind: "superseded", deal, reason };
  return {
    kind: "move",
    deal,
    followedMeeting,
    heldMeetingId: marksMeetingHeld(followedMeeting) ? followedMeeting._id : null,
  };
}

/**
 * Applies the plan:
 * - superseded: the dead link is expired, with the `followUp.expired` event a
 *   booking writes when it retires a link, and the deal is left alone;
 * - move: the deal goes to Follow-up through the stage machine, as
 *   generating the link does now, and the call the link followed is marked
 *   held when it is still unrecorded, through the helper the create
 *   mutations use (the old confirm did the same). A deal with two stuck
 *   links moves once; the second finds it at Follow-up.
 */
export async function applyStuckLink(
  ctx: MutationCtx,
  followUp: Doc<"followUps">,
): Promise<StuckLinkPlan | null> {
  const now = Date.now();
  const plan = await planStuckLink(ctx, followUp, now);
  if (!plan) return null;

  if (plan.kind === "superseded") {
    await ctx.db.patch("followUps", followUp._id, { status: "expired" });
    await emitDomainEvent(ctx, {
      tenantId: followUp.tenantId,
      entityType: "followUp",
      entityId: followUp._id,
      eventType: "followUp.expired",
      source: "system",
      fromStatus: "pending",
      toStatus: "expired",
      metadata: {
        type: followUp.type,
        reason: followUp.reason,
        opportunityId: followUp.opportunityId,
        origin: "stuck_scheduling_link_superseded",
        supersededBy: plan.reason,
      },
      occurredAt: now,
    });
    return plan;
  }

  // Booked or Call held -> Follow-up.
  await transitionOpportunity(ctx, plan.deal._id, {
    to: { stage: "follow_up" },
    fields: { updatedAt: now },
    source: "system",
    metadata: {
      followUpId: followUp._id,
      linkCreatedAt: followUp.createdAt,
      origin: "stuck_scheduling_link_backfill",
    },
    occurredAt: now,
  });
  if (plan.heldMeetingId) {
    await completeMeetingForOutcome(ctx, {
      meetingId: plan.heldMeetingId,
      opportunityId: plan.deal._id,
      toMeetingStatus: "held",
      recordedAt: now,
    });
  }
  return plan;
}
