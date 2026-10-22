type EventLabel = {
  iconHint: string;
  verb: string;
};

export const EVENT_LABELS: Record<string, EventLabel> = {
  "customer.conversion_rolled_back": {
    verb: "rolled back a customer conversion",
    iconHint: "undo-2",
  },
  "customer.converted": {
    verb: "converted a lead into a customer",
    iconHint: "badge-check",
  },
  "customer.status_changed": {
    verb: "changed a customer status",
    iconHint: "refresh-cw",
  },
  "enrollment.created": {
    verb: "enrolled a customer in a program",
    iconHint: "badge-check",
  },
  "enrollment.removed": {
    verb: "removed a program enrollment",
    iconHint: "undo-2",
  },
  "enrollment.status_changed": {
    verb: "changed a program enrollment status",
    iconHint: "refresh-cw",
  },
  "followUp.booked": {
    verb: "booked a follow-up",
    iconHint: "calendar-check",
  },
  "followUp.completed": {
    verb: "completed a follow-up task",
    iconHint: "check-circle-2",
  },
  "followUp.created": {
    verb: "created a follow-up",
    iconHint: "calendar-plus",
  },
  "followUp.expired": {
    verb: "expired a follow-up",
    iconHint: "calendar-x-2",
  },
  "lead.captured": {
    verb: "captured a prospect",
    iconHint: "user-round-plus",
  },
  "lead.capture_voided": {
    verb: "voided a lead gen capture",
    iconHint: "user-x",
  },
  "lead.created": {
    verb: "created a lead",
    iconHint: "user-plus",
  },
  "lead.merged": {
    verb: "merged leads",
    iconHint: "combine",
  },
  "lead.status_changed": {
    verb: "changed a lead status",
    iconHint: "git-branch",
  },
  "meeting.canceled": {
    verb: "canceled a meeting",
    iconHint: "calendar-x-2",
  },
  "meeting.created": {
    verb: "booked a meeting",
    iconHint: "calendar-plus-2",
  },
  "meeting.no_show": {
    verb: "marked a meeting as no-show",
    iconHint: "user-x",
  },
  "meeting.no_show_reverted": {
    verb: "reverted a no-show",
    iconHint: "rotate-ccw",
  },
  "meeting.status_changed": {
    verb: "changed a meeting status",
    iconHint: "arrow-right-left",
  },
  "opportunity.created": {
    verb: "created an opportunity",
    iconHint: "sparkles",
  },
  "opportunity.marked_lost": {
    verb: "marked an opportunity as lost",
    iconHint: "x-circle",
  },
  // From PR 8 a deal's moves are this event, with stages in fromStatus and
  // toStatus (docs/plans/phase-5-deal-status.md §4.7); the older ones above
  // keep their statuses.
  "opportunity.stage_changed": {
    verb: "changed a deal stage",
    iconHint: "arrow-right-left",
  },
  "opportunity.status_changed": {
    verb: "changed an opportunity status",
    iconHint: "arrow-right-left",
  },
  "payment.disputed": {
    verb: "disputed a payment",
    iconHint: "circle-alert",
  },
  "payment.corrected": {
    verb: "corrected payment details",
    iconHint: "pencil",
  },
  "payment.recorded": {
    verb: "recorded a payment",
    iconHint: "dollar-sign",
  },
  "payment.verified": {
    verb: "marked payment reviewed",
    iconHint: "badge-check",
  },
  "payment.voided": {
    verb: "voided a payment",
    iconHint: "circle-x",
  },
  "user.created": {
    verb: "created a team member",
    iconHint: "user-round-plus",
  },
  "user.deactivated": {
    verb: "deactivated a team member",
    iconHint: "user-round-x",
  },
  "user.reactivated": {
    verb: "reactivated a team member",
    iconHint: "user-round-check",
  },
  "user.role_changed": {
    verb: "changed a team member role",
    iconHint: "shield",
  },
};

export function getEventLabel(eventType: string): EventLabel {
  return EVENT_LABELS[eventType] ?? {
    verb: eventType,
    iconHint: "activity",
  };
}
