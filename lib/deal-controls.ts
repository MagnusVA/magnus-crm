import type { MeetingStatus } from "../convex/lib/statusTransitions";
import type { MissedMeeting } from "../convex/opportunities/dealState";
import type { DealLabel } from "../convex/opportunities/stageLabels";

/**
 * Which controls the meeting and reminder pages show, read from the deal's
 * position, the loss the system wrote and its reschedule link instead of
 * `opportunities.status` (docs/plans/phase-5-deal-status.md §4.6, §6.4).
 * Each check names the status it replaces and holds on the same deals: the
 * asserts prove the new fields rebuild the status on every deal. Pages only
 * hide controls; the mutations check the deal again.
 */

/** What the detail payloads carry for a deal's badge (`dealLabelOf`). */
export type DealControlFields = Pick<DealLabel, "position" | "systemLoss">;

/** With the meeting page's `rescheduleLinkPending` (`closer/meetingDetail.ts`). */
export type MeetingDealControlFields = DealControlFields & {
  rescheduleLinkPending: boolean;
};

/** Closed won: today's `payment_received`. */
export function isDealWon(deal: DealControlFields): boolean {
  return deal.position === "won";
}

/**
 * Waiting for its meeting's outcome: Booked, or Call held for a side deal,
 * today's `scheduled`.
 */
export function isAwaitingOutcome(deal: DealControlFields): boolean {
  return deal.position === "booked" || deal.position === "call_held";
}

/**
 * The missed meeting that closed the deal, if one did: today's `no_show` or
 * `canceled`. `systemLoss` is set only on a deal the system closed lost, so a
 * loss a person recorded is never one, whatever its text.
 */
export function missedMeetingOf(deal: DealControlFields): MissedMeeting | null {
  return deal.systemLoss === "no_show" || deal.systemLoss === "canceled" ? deal.systemLoss : null;
}

/** A no-show closed the deal: today's `no_show`. */
export function isClosedByNoShow(deal: DealControlFields): boolean {
  return missedMeetingOf(deal) === "no_show";
}

/**
 * Follow-up with a pending reschedule link: today's `reschedule_link_sent`.
 * A link left pending at another stage doesn't count, as the status didn't.
 */
export function isWaitingOnRescheduleLink(deal: MeetingDealControlFields): boolean {
  return deal.position === "follow_up" && deal.rescheduleLinkPending;
}

/** The groups of actions the admin's meeting bar shows. */
export type AdminMeetingActions = {
  /** Log payment, follow-up, mark no-show and mark lost. */
  outcome: boolean;
  /** "Schedule follow-up" without the meeting. */
  scheduleFollowUp: boolean;
  /** "Reschedule link". */
  rescheduleLink: boolean;
};

/**
 * The admin meeting page's action bar, or null when it shows none:
 *
 * | Deal                          | Today                     | Actions                      |
 * | ----------------------------- | ------------------------- | ---------------------------- |
 * | Booked or Call held           | `scheduled`               | outcome, if the meeting is scheduled |
 * | Closed lost by a no-show      | `no_show`                 | schedule follow-up, reschedule link |
 * | Closed lost by a cancellation | `canceled`                | schedule follow-up           |
 * | Qualified, Follow-up          | `qualified_pending`, `follow_up_scheduled`, `reschedule_link_sent` | an empty bar |
 * | Closed otherwise              | `payment_received`, `lost` | none                        |
 */
export function adminMeetingActions(
  deal: DealControlFields,
  meetingStatus: MeetingStatus,
): AdminMeetingActions | null {
  const missedMeeting = missedMeetingOf(deal);
  if ((deal.position === "won" || deal.position === "lost") && missedMeeting === null) {
    return null;
  }
  return {
    outcome: meetingStatus === "scheduled" && isAwaitingOutcome(deal),
    scheduleFollowUp: missedMeeting !== null,
    rescheduleLink: missedMeeting === "no_show",
  };
}

/**
 * The reminder can no longer move the deal: it is Closed, won or lost.
 *
 * This is the one control that changes (§4.6). Today's set was
 * `payment_received`, `lost` and `no_show`, so a canceled deal showed the
 * outcome buttons, and the server refuses the payment, the loss and a new
 * reminder on it; only the closer's "no response, close only" went through.
 * A canceled deal now counts as finished too, as a no-show's does.
 */
export function isReminderDealFinished(deal: DealControlFields): boolean {
  return deal.position === "won" || deal.position === "lost";
}
