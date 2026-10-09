
export const OPPORTUNITY_STATUSES = [
  "qualified_pending",
  "scheduled",
  "payment_received",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "lost",
  "canceled",
  "no_show",
] as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const MEETING_STATUSES = [
  "scheduled",
  "completed",
  "canceled",
  "no_show",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const VALID_TRANSITIONS: Record<
  OpportunityStatus,
  OpportunityStatus[]
> = {
  qualified_pending: ["scheduled", "lost"],
  scheduled: [
    "payment_received",
    "follow_up_scheduled",
    "lost",
    "no_show",
    "canceled",
  ],
  canceled: ["follow_up_scheduled", "scheduled"],
  no_show: ["follow_up_scheduled", "reschedule_link_sent", "scheduled"],
  // Reminder-driven outcomes can now terminate the opportunity directly.
  // Keep "scheduled" for the existing re-booking path.
  follow_up_scheduled: ["scheduled", "payment_received", "lost"],
  reschedule_link_sent: ["scheduled"],
  payment_received: [],
  lost: [],
};

// The validators are plain predicates: callers also use them to pick a branch,
// so they don't log. A caller that rejects a write throws, and the failure
// is reported with the request.
export function validateTransition(
  from: OpportunityStatus,
  to: OpportunityStatus,
): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

// === Meeting Status Transitions ===

export const MEETING_VALID_TRANSITIONS: Record<
  MeetingStatus,
  MeetingStatus[]
> = {
  scheduled: ["completed", "canceled", "no_show"],
  completed: [],
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

export const VALID_LEAD_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  active: ["converted", "merged"],
  converted: [],
  merged: [],
};

export function validateLeadTransition(
  from: LeadStatus,
  to: LeadStatus,
): boolean {
  return VALID_LEAD_TRANSITIONS[from].includes(to);
}
// === End Feature D ===
