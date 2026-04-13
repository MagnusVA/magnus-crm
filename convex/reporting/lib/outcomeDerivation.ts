import type { Doc } from "../../_generated/dataModel";

export type CallOutcome =
  | "sold"
  | "lost"
  | "no_show"
  | "canceled"
  | "rescheduled"
  | "dq"
  | "follow_up"
  | "scheduled"
  | "in_progress";

/**
 * Priority order:
 * sold > lost > no_show > canceled > rescheduled > dq > follow_up > in_progress > scheduled
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

  if (meeting.meetingOutcome === "not_qualified") {
    return "dq";
  }

  if (
    meeting.status === "completed" &&
    opportunity.status === "follow_up_scheduled"
  ) {
    return "follow_up";
  }

  if (meeting.status === "in_progress") {
    return "in_progress";
  }

  return "scheduled";
}
