export const OPPORTUNITY_STATUSES = [
  "scheduled",
  "in_progress",
  "payment_received",
  "follow_up_scheduled",
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
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const VALID_TRANSITIONS: Record<
  OpportunityStatus,
  OpportunityStatus[]
> = {
  scheduled: ["in_progress", "canceled", "no_show"],
  in_progress: ["payment_received", "follow_up_scheduled", "lost"],
  canceled: ["follow_up_scheduled"],
  no_show: ["follow_up_scheduled"],
  follow_up_scheduled: ["scheduled"],
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
