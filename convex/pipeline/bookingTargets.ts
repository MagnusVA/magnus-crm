import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { MeetingStatus } from "../lib/statusTransitions";
import {
  isMissedMeetingLoss,
  loadPendingRescheduleLink,
  type DealStateFields,
  type MissedMeeting,
} from "../opportunities/dealState";
import {
  dealPosition,
  dealStageOf,
  isAllowedStageOutcome,
  type DealPosition,
} from "../opportunities/stages";

// Which deal a Calendly booking may move, read from the deal's stage, outcome,
// loss and tasks (docs/plans/phase-5-deal-status.md §4.3, §4.6, §6.7). Each
// predicate gives the answer of the status check it replaced, named in its
// comment, for every deal the dual write leaves; bookingTargets.test.ts
// proves it. The moves themselves still go through transitionOpportunity
// with a status until PR 8.

/** The tasks a booking rule reads: whether a reschedule link waits on the person. */
export type DealTasks = { hasPendingRescheduleLink: boolean };

/**
 * The deal's position, or null on a stage and outcome pair the stage doesn't
 * allow, which assertDealStages reports. A booking rule treats such a deal as
 * one it may not move, so the booking blocks or starts a new deal rather than
 * failing. The booking's log lines name the deal by it too.
 */
export function positionOf(deal: DealStateFields): DealPosition | null {
  const { stage, outcome } = dealStageOf(deal);
  return isAllowedStageOutcome(stage, outcome) ? dealPosition(stage, outcome) : null;
}

/** Booked, or Call held for a side deal. Today's `scheduled`. */
function isBookedOrCallHeld(deal: DealStateFields): boolean {
  const position = positionOf(deal);
  return position === "booked" || position === "call_held";
}

/** The deal's tasks, with one indexed read. */
export async function loadDealTasks(
  ctx: QueryCtx | MutationCtx,
  dealId: Id<"opportunities">,
): Promise<DealTasks> {
  const { count } = await loadPendingRescheduleLink(ctx, dealId);
  return { hasPendingRescheduleLink: count > 0 };
}

/**
 * Whether a booking through a link the CRM sent (`utm_source=ptdom`) takes
 * the deal: a Follow-up deal, with or without a reschedule link. Today
 * `follow_up_scheduled` or `reschedule_link_sent`.
 */
export function isBookingLinkTarget(deal: DealStateFields): boolean {
  return positionOf(deal) === "follow_up";
}

/**
 * Follow-up with a pending reschedule link: today's `reschedule_link_sent`.
 * The booking link that takes such a deal expires its other pending
 * reschedule links (§4.5).
 */
export function isWaitingOnRescheduleLink(deal: DealStateFields, tasks: DealTasks): boolean {
  return positionOf(deal) === "follow_up" && tasks.hasPendingRescheduleLink;
}

/**
 * Whether a booking without a link joins the deal: Follow-up with no pending
 * reschedule link. Today's `follow_up_scheduled`. A deal waiting on a
 * reschedule link takes only a booking through that link.
 */
export function isFollowUpJoinTarget(deal: DealStateFields, tasks: DealTasks): boolean {
  return positionOf(deal) === "follow_up" && !tasks.hasPendingRescheduleLink;
}

/**
 * What a Calendly reschedule (the new booking names `old_invitee`) does with
 * the old booking's deal:
 * - "move": the deal is Booked, or Call held for a side deal (today
 *   `scheduled`), so it moves to the new booking;
 * - "ended": a missed meeting closed it (today `no_show` or `canceled`), so
 *   the booking goes on as one without a target, and makes a new deal unless
 *   a join takes it (§4.3);
 * - "review": anything else, which holds the booking for review.
 */
export function calendlyRescheduleTarget(deal: DealStateFields): "move" | "ended" | "review" {
  if (isBookedOrCallHeld(deal)) return "move";
  if (isMissedMeetingLoss(deal)) return "ended";
  return "review";
}

/**
 * Whether today's state machine lets a booking move the deal to `scheduled`
 * (`validateTransition(status, "scheduled")`): Qualified, Follow-up with or
 * without a reschedule link, or a deal a missed meeting closed. PR 8 replaces
 * it with the stage machine (§4.4).
 */
export function allowsMoveToBooked(deal: DealStateFields): boolean {
  const position = positionOf(deal);
  return position === "qualified" || position === "follow_up" || isMissedMeetingLoss(deal) !== null;
}

/** The meeting statuses a Calendly fact can leave the deal's current booking at. */
export type BookingFactMeetingStatus = Exclude<MeetingStatus, "completed">;

/**
 * What the deal says of its current booking while Calendly's facts still
 * move it: "scheduled" while it is Booked or Call held, or the missed meeting
 * that closed it. Null for any other deal (Qualified, Follow-up, won, or a
 * loss a person recorded or the Slack expiry wrote), which no Calendly fact
 * moves. Today's `scheduled`, `no_show` and `canceled`, the statuses
 * bookingFacts.ts called mutable.
 */
function bookingStateOf(deal: DealStateFields): "scheduled" | MissedMeeting | null {
  if (isBookedOrCallHeld(deal)) return "scheduled";
  return isMissedMeetingLoss(deal);
}

/**
 * Whether a Calendly fact that leaves the deal's current booking at
 * `meetingStatus` moves the deal: a deal the facts still move that doesn't
 * already say it. Today: a `scheduled`, `no_show` or `canceled` deal whose
 * status isn't the meeting's.
 */
export function bookingFactMovesDeal(
  deal: DealStateFields,
  meetingStatus: BookingFactMeetingStatus,
): boolean {
  const state = bookingStateOf(deal);
  return state !== null && state !== meetingStatus;
}

/**
 * The deals among `deals` that a booking without a link may join as a
 * follow-up, in the order given: Follow-up deals with no pending reschedule
 * link. Reads the tasks of the Follow-up deals only, and stops at two, which
 * is already ambiguous.
 */
export async function followUpJoinTargets(
  ctx: QueryCtx | MutationCtx,
  deals: Doc<"opportunities">[],
): Promise<Doc<"opportunities">[]> {
  const targets: Doc<"opportunities">[] = [];
  for (const deal of deals) {
    if (positionOf(deal) !== "follow_up") continue;
    if (isFollowUpJoinTarget(deal, await loadDealTasks(ctx, deal._id))) targets.push(deal);
    if (targets.length > 1) break;
  }
  return targets;
}
