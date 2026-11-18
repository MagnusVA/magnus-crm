import type { Doc, Id } from "../_generated/dataModel";

// The deal's state machine is the stage machine in
// convex/opportunities/stages.ts (docs/plans/phase-5-deal-status.md §4.4),
// beside the frozen list of the old statuses.

export const MEETING_STATUSES = [
  "scheduled",
  "held",
  "canceled",
  "no_show",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

// === Meeting Status Transitions ===

export const MEETING_VALID_TRANSITIONS: Record<
  MeetingStatus,
  MeetingStatus[]
> = {
  scheduled: ["held", "canceled", "no_show"],
  held: [],
  canceled: [],
  no_show: ["scheduled"], // Webhook reversal (Calendly no-show deletion)
};

export function validateMeetingTransition(
  from: MeetingStatus,
  to: MeetingStatus,
): boolean {
  return MEETING_VALID_TRANSITIONS[from].includes(to);
}

// === Meeting exceptions ===
// Moves the machine above doesn't allow, each for the one writer that names
// it. Held stays terminal for everything else.

export const MEETING_TRANSITION_EXCEPTIONS = {
  // The undo of a held mark a call decision wrote takes the meeting back to
  // scheduled. Its only writer is `withdrawAutomatedHeld`
  // (lib/meetingAttendanceUndo.ts).
  automation_held_undone: { from: "held", to: "scheduled" },
} as const satisfies Record<string, { from: MeetingStatus; to: MeetingStatus }>;

export type MeetingTransitionException = keyof typeof MEETING_TRANSITION_EXCEPTIONS;

/**
 * Whether `automation_held_undone` may move this meeting from held back to
 * scheduled: the held mark came from Call insights through this decision,
 * and nothing was recorded on the deal after the decision's write (its
 * revision is still the one the write left).
 */
export function validateAutomationHeldUndone(args: {
  meeting: Pick<Doc<"meetings">, "status" | "attendanceSource" | "attendanceDecisionId">;
  decisionId: Id<"resultAutomationDecisions">;
  humanResultRevision: number;
  humanResultRevisionAfter: number | undefined;
}): boolean {
  const { meeting } = args;
  const rule = MEETING_TRANSITION_EXCEPTIONS.automation_held_undone;
  return meeting.status === rule.from &&
    meeting.attendanceSource === "call_insights" &&
    meeting.attendanceDecisionId !== undefined &&
    meeting.attendanceDecisionId === args.decisionId &&
    args.humanResultRevisionAfter !== undefined &&
    args.humanResultRevision === args.humanResultRevisionAfter;
}

// === Feature D: Lead Status Transitions ===
export const LEAD_STATUSES = ["active", "converted", "merged"] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

// A person is `converted` while they have an enrollment, and goes back to
// `active` when the last one is removed (docs/plans/phase-4-customers.md
// §4.2, §4.3). A customer can be merged (§4.7).
export const VALID_LEAD_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  active: ["converted", "merged"],
  converted: ["active", "merged"],
  merged: [],
};

export function validateLeadTransition(
  from: LeadStatus,
  to: LeadStatus,
): boolean {
  return VALID_LEAD_TRANSITIONS[from].includes(to);
}
// === End Feature D ===
