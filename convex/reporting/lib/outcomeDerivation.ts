import type { Doc } from "../../_generated/dataModel";
import { dealStageOf, isSystemLossReason } from "../../opportunities/stages";

export type CallOutcome =
  | "sold"
  | "lost"
  | "no_show"
  | "canceled"
  | "rescheduled"
  | "dq"
  | "follow_up"
  | "scheduled";

// A meeting's outcome from its deal's stage and outcome
// (docs/plans/phase-5-deal-status.md §6.6).

type DealLossFields = Pick<
  Doc<"opportunities">,
  "source" | "stage" | "outcome" | "lostReason" | "lostByUserId"
>;

/**
 * A deal a person closed as lost: Closed lost, and not a loss the system
 * wrote. The system's losses (the Slack expiry, a no-show, a cancellation)
 * carry a system reason code and no person (§4.1); a person's loss has
 * `lostByUserId`, or free text or no reason.
 */
export function isPersonLoss(deal: DealLossFields): boolean {
  const { stage, outcome } = dealStageOf(deal);
  if (stage !== "closed" || outcome !== "lost") {
    return false;
  }
  return deal.lostByUserId !== undefined || !isSystemLossReason(deal.lostReason);
}

/**
 * Whether the derivation needs to know if the deal has a pending reschedule
 * link: only a held meeting on a deal at Follow-up does.
 */
export function needsRescheduleLinkCheck(
  meeting: Doc<"meetings">,
  opportunity: DealLossFields,
): boolean {
  return meeting.status === "completed" && dealStageOf(opportunity).stage === "follow_up";
}

/**
 * Priority order:
 * sold > lost > no_show > canceled > rescheduled > dq > follow_up > scheduled
 *
 * Lost is a deal a person closed, so a missed meeting's deal keeps its meeting
 * a no-show or a cancellation; a follow-up is a held meeting on a deal at
 * Follow-up with no pending reschedule link (§4.6).
 *
 * No code path produces "dq" yet: its old trigger, `meetingOutcome ===
 * "not_qualified"`, went with the meeting comments feature. When Team
 * Performance needs it, add an explicit disqualify action, a structured loss
 * reason, or a tagged comment.
 */
export function deriveCallOutcomeByStage(
  meeting: Doc<"meetings">,
  opportunity: Doc<"opportunities">,
  hasPayment: boolean,
  isRescheduled: boolean,
  hasPendingRescheduleLink: boolean,
): CallOutcome {
  if (hasPayment) {
    return "sold";
  }

  if (isPersonLoss(opportunity) && opportunity.latestMeetingId === meeting._id) {
    return "lost";
  }

  if (meeting.status === "no_show") {
    return "no_show";
  }

  if (meeting.status === "canceled") {
    return "canceled";
  }

  if (isRescheduled) {
    return "rescheduled";
  }

  if (needsRescheduleLinkCheck(meeting, opportunity) && !hasPendingRescheduleLink) {
    return "follow_up";
  }

  return "scheduled";
}
