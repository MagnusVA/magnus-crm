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

  if (meeting.status === "meeting_overran") {
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
  // the meeting-comments feature (see plans/meeting-comments/phases/phase3.md
  // §3D and the design doc §6.3).
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

  if (opportunity.status === "meeting_overran") {
    return "in_progress";
  }

  if (meeting.status === "in_progress") {
    return "in_progress";
  }

  return "scheduled";
}
