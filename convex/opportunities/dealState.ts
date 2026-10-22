import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  SYSTEM_LOSS_REASONS,
  dealPosition,
  dealStageOf,
  type DealPosition,
  type DealStage,
  type OpportunityStatus,
} from "./stages";

// A deal's state, read from the stage, the outcome, the loss and the tasks
// (docs/plans/phase-5-deal-status.md §4.5, §4.6): what the guards and the
// booking rules test. `legacyStatus` names it in the old statuses, for the
// booking history's old events (pipeline/bookingHistory.ts).

/** The deal fields the state reads. */
export type DealStateFields = Pick<
  Doc<"opportunities">,
  "source" | "stage" | "outcome" | "lostReason" | "lostByUserId"
>;

export type MissedMeeting =
  | typeof SYSTEM_LOSS_REASONS.no_show
  | typeof SYSTEM_LOSS_REASONS.canceled;

/**
 * Which missed meeting closed the deal, if one did: Closed lost by the
 * system (no `lostByUserId`) with the reason `no_show` or `canceled` (§4.3).
 * A person's loss is never a missed meeting, whatever its text.
 */
export function isMissedMeetingLoss(deal: DealStateFields): MissedMeeting | null {
  const { stage, outcome } = dealStageOf(deal);
  if (stage !== "closed" || outcome !== "lost" || deal.lostByUserId !== undefined) {
    return null;
  }
  switch (deal.lostReason) {
    case SYSTEM_LOSS_REASONS.no_show:
      return SYSTEM_LOSS_REASONS.no_show;
    case SYSTEM_LOSS_REASONS.canceled:
      return SYSTEM_LOSS_REASONS.canceled;
    default:
      return null;
  }
}

// Far above the reschedule links one deal gets. More than one pending is a
// data problem assertDealStages reports.
const RESCHEDULE_LINK_SCAN = 10;

export type PendingRescheduleLink = {
  /** The newest pending reschedule link, or null. */
  link: Doc<"followUps"> | null;
  /** How many are pending, up to the scan's cap. */
  count: number;
};

/**
 * The deal's pending reschedule link: a pending scheduling link with the
 * reason `no_show_follow_up`, which only the reschedule link actions write
 * (closer/noShowActions.ts, admin/meetingActions.ts). An ordinary scheduling
 * link (`closer_initiated`) or a reminder isn't one (§4.5).
 */
export async function loadPendingRescheduleLink(
  ctx: QueryCtx | MutationCtx,
  dealId: Id<"opportunities">,
): Promise<PendingRescheduleLink> {
  const pending = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q.eq("opportunityId", dealId).eq("status", "pending").eq("reason", "no_show_follow_up"),
    )
    .order("desc")
    .take(RESCHEDULE_LINK_SCAN);
  // The index has no type; every row with this reason is a link, and the
  // check keeps a row written otherwise out.
  const links = pending.filter((followUp) => followUp.type === "scheduling_link");
  return { link: links[0] ?? null, count: links.length };
}

/**
 * The deal's state as an old status, in the order of §4.6, for comparing it
 * with the old events (pipeline/bookingHistory.ts): Qualified is
 * `qualified_pending`; Booked and Call held are `scheduled`; Follow-up is
 * `reschedule_link_sent` with a pending reschedule link and
 * `follow_up_scheduled` without; Closed won is `payment_received`; Closed
 * lost is `no_show` or `canceled` when a missed meeting closed it, and `lost`
 * otherwise. Throws on a pair the stage doesn't allow.
 */
export function legacyStatus(
  deal: DealStateFields,
  tasks: { hasPendingRescheduleLink: boolean },
): OpportunityStatus {
  const { stage, outcome } = dealStageOf(deal);
  switch (dealPosition(stage, outcome)) {
    case "qualified":
      return "qualified_pending";
    case "booked":
    case "call_held":
      return "scheduled";
    case "follow_up":
      return tasks.hasPendingRescheduleLink ? "reschedule_link_sent" : "follow_up_scheduled";
    case "won":
      return "payment_received";
    case "lost":
      return isMissedMeetingLoss(deal) ?? "lost";
  }
}

export type DealState = {
  position: DealPosition;
  missedMeeting: MissedMeeting | null;
  /** Whether the deal has a pending reschedule link, at any stage. */
  rescheduleLinkPending: boolean;
};

/** Everything a guard reads about a deal's state, with one indexed read. */
export async function loadDealState(
  ctx: QueryCtx | MutationCtx,
  deal: DealStateFields & Pick<Doc<"opportunities">, "_id">,
): Promise<DealState> {
  const { stage, outcome } = dealStageOf(deal);
  const { count } = await loadPendingRescheduleLink(ctx, deal._id);
  return {
    position: dealPosition(stage, outcome),
    missedMeeting: isMissedMeetingLoss(deal),
    rescheduleLinkPending: count > 0,
  };
}

/**
 * What a new deal is written with: its starting stage, open. A Calendly
 * booking starts Booked, a Slack qualification Qualified, a side deal Call
 * held.
 */
export function newDealStageFields(stage: Exclude<DealStage, "closed">): {
  stage: Exclude<DealStage, "closed">;
  outcome: "open";
} {
  return { stage, outcome: "open" };
}
