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

/**
 * Priority order:
 * sold > lost > no_show > canceled > rescheduled > dq > follow_up > scheduled
 */
export function deriveCallOutcome(
  meeting: Doc<"meetings">,
  opportunity: Doc<"opportunities">,
  hasPayment: boolean,
  isRescheduled: boolean,
): CallOutcome {
  if (hasPayment) {
    return "sold";
  }

  if (opportunity.status === "lost" && opportunity.latestMeetingId === meeting._id) {
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

  // TODO: Re-implement the "dq" (disqualified) CallOutcome.
  //
  // The previous trigger was `meeting.meetingOutcome === "not_qualified"`,
  // but `meetingOutcome` has been removed from all read/write paths as of
  // the meeting-comments feature.
  //
  // When the v0.6b Team Performance reporting feature ships, choose one of:
  //   (a) explicit `disqualifyMeeting` mutation that sets a dedicated field
  //   (b) derive DQ from `opportunity.status === "lost"` + a structured
  //       lostReason enum
  //   (c) structured comment tag (e.g., a comment with metadata.tag = "dq")
  //
  // Until then, `CallOutcome` still exposes "dq" as a variant but no code
  // path produces it — this is intentional and documented.

  if (
    meeting.status === "completed" &&
    opportunity.status === "follow_up_scheduled"
  ) {
    return "follow_up";
  }

  return "scheduled";
}

// The stage way (docs/plans/phase-5-deal-status.md §6.6), beside the status
// way above until PR 6 moves the team report to it. The parity query
// compareTeamOutcomes (convex/opportunities/stageParity.ts) checks that both
// give every meeting the same outcome.

type DealLossFields = Pick<
  Doc<"opportunities">,
  "status" | "source" | "stage" | "outcome" | "lostReason" | "lostByUserId"
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
 * Whether the stage-way derivation needs to know if the deal has a pending
 * reschedule link: only a held meeting on a deal at Follow-up does.
 */
export function needsRescheduleLinkCheck(
  meeting: Doc<"meetings">,
  opportunity: DealLossFields,
): boolean {
  return meeting.status === "completed" && dealStageOf(opportunity).stage === "follow_up";
}

/**
 * `deriveCallOutcome` from the stage, in the same priority order. Lost is a
 * deal a person closed, so a missed meeting's deal keeps its meeting a no-show
 * or a cancellation; a follow-up is a held meeting on a deal at Follow-up with
 * no pending reschedule link, today's `follow_up_scheduled` (§4.6).
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
