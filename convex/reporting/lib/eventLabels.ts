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
  "meeting.admin_resolved": {
    verb: "resolved a meeting as admin",
    iconHint: "shield-check",
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
  "meeting.overran_closer_responded": {
    verb: "responded to an overran meeting",
    iconHint: "message-square",
  },
  "meeting.overran_detected": {
    verb: "flagged a meeting as overran",
    iconHint: "alert-triangle",
  },
  "meeting.overran_review_resolved": {
    verb: "resolved an overran review",
    iconHint: "gavel",
  },
  "meeting.started": {
    verb: "started a meeting",
    iconHint: "play",
  },
  "meeting.status_changed": {
    verb: "changed a meeting status",
    iconHint: "arrow-right-left",
  },
  "meeting.stopped": {
    verb: "ended a meeting",
    iconHint: "square",
  },
  "meeting.times_manually_set": {
    verb: "manually set meeting times",
    iconHint: "clock-3",
  },
  "meeting.webhook_ignored_overran": {
    verb: "ignored a late webhook for a flagged meeting",
    iconHint: "filter",
  },
  "opportunity.created": {
    verb: "created an opportunity",
    iconHint: "sparkles",
  },
  "opportunity.marked_lost": {
    verb: "marked an opportunity as lost",
    iconHint: "x-circle",
  },
  "opportunity.status_changed": {
    verb: "changed an opportunity status",
    iconHint: "arrow-right-left",
  },
  "payment.disputed": {
    verb: "disputed a payment",
    iconHint: "circle-alert",
  },
  "payment.recorded": {
    verb: "recorded a payment",
    iconHint: "dollar-sign",
  },
  "payment.verified": {
    verb: "verified a payment",
    iconHint: "badge-check",
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
