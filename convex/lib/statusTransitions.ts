
// The deal's state machine is the stage machine in
// convex/opportunities/stages.ts (docs/plans/phase-5-deal-status.md §4.4),
// beside the frozen list of the old statuses.

export const MEETING_STATUSES = [
  "scheduled",
  "completed",
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
  scheduled: ["completed", "held", "canceled", "no_show"],
  completed: [],
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
