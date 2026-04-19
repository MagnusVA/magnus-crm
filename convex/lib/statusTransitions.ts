export const OPPORTUNITY_STATUSES = [
  "scheduled",
  "in_progress",
  "meeting_overran",
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
  "in_progress",
  "completed",
  "canceled",
  "no_show",
  "meeting_overran",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const VALID_TRANSITIONS: Record<
  OpportunityStatus,
  OpportunityStatus[]
> = {
  scheduled: ["in_progress", "meeting_overran", "canceled", "no_show"],
  in_progress: ["payment_received", "follow_up_scheduled", "no_show", "lost"],
  meeting_overran: [
    "payment_received",
    "follow_up_scheduled",
    "no_show",
    "lost",
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

export function validateTransition(
  from: OpportunityStatus,
  to: OpportunityStatus,
): boolean {
  const valid = VALID_TRANSITIONS[from].includes(to);
  if (!valid) {
    console.warn("[StatusTransition] Invalid transition rejected", { from, to, allowedTargets: VALID_TRANSITIONS[from] });
  } else {
    console.log("[StatusTransition] Transition validated", { from, to });
  }
  return valid;
}

// === Meeting Status Transitions ===

export const MEETING_VALID_TRANSITIONS: Record<
  MeetingStatus,
  MeetingStatus[]
> = {
  scheduled: ["in_progress", "completed", "meeting_overran", "canceled", "no_show"],
  in_progress: ["completed", "no_show", "canceled"],
  // v2: Closer can mark a flagged meeting's lead as no-show directly.
  // "completed" remains the false-positive correction path.
  meeting_overran: ["completed", "no_show"],
  completed: [],
  canceled: [],
  no_show: ["scheduled"], // Webhook reversal (Calendly no-show deletion)
};

export function validateMeetingTransition(
  from: MeetingStatus,
  to: MeetingStatus,
): boolean {
  const valid = MEETING_VALID_TRANSITIONS[from].includes(to);
  if (!valid) {
    console.warn("[StatusTransition] Invalid meeting transition rejected", {
      from,
      to,
      allowedTargets: MEETING_VALID_TRANSITIONS[from],
    });
  } else {
    console.log("[StatusTransition] Meeting transition validated", { from, to });
  }
  return valid;
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
  const valid = VALID_LEAD_TRANSITIONS[from].includes(to);
  if (!valid) {
    console.warn("[StatusTransition] Invalid lead transition rejected", {
      from,
      to,
      allowedTargets: VALID_LEAD_TRANSITIONS[from],
    });
  } else {
    console.log("[StatusTransition] Lead transition validated", { from, to });
  }
  return valid;
}
// === End Feature D ===
