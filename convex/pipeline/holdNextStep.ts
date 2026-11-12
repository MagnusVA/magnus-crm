/**
 * What a held or failed booking's reason means in plain words, the next step,
 * and the actions that can help. Pure, so the recovery panel and the booking
 * review page share it. An unknown reason shows its code and needs an
 * operator.
 */

export type HoldAction = "open_review" | "open_waiting" | "link_host" | "open_people" | "retry";

export type HoldExplanation = {
  /** Why the booking is held, in one sentence. */
  cause: string;
  /** What to do next, in one sentence. */
  nextStep: string;
  actions: HoldAction[];
  /** No admin action settles it: an operator has to. */
  needsOperator: boolean;
};

const OPERATOR = "An operator has to place this booking.";

const EXPLANATIONS: Record<string, Omit<HoldExplanation, "needsOperator"> & { needsOperator?: boolean }> = {
  phone_match_new_email: {
    cause: "Its email is new to the CRM, and its phone belongs to a person who already has a different email.",
    nextStep: "Open the review and say whether this is the same person.",
    actions: ["open_review", "open_people"],
  },
  identity_conflict: {
    cause: "Its details name more than one person on file, or a person whose record needs repair.",
    nextStep: "Open the people it matched. Merge them or fix who holds the detail, then retry.",
    actions: ["open_review", "open_people", "retry"],
  },
  waiting_for_earlier_booking: {
    cause: "An earlier booking from the same email is still held. Bookings from one email are added oldest first.",
    nextStep: "Settle the earlier booking. This one is added right after it.",
    actions: ["open_waiting"],
  },
  host_not_linked: {
    cause: "The Calendly host isn't linked to a closer.",
    nextStep: "Link the host to a closer in Team, then retry.",
    actions: ["link_host", "retry"],
  },
  host_inactive: {
    cause: "The Calendly host is linked to a closer who is no longer active.",
    nextStep: "Reactivate the closer or link the host to another one, then retry.",
    actions: ["link_host", "retry"],
  },
  invalid_identity_relationship: {
    cause: "A person it matched points at a merged or missing record.",
    nextStep: OPERATOR,
    actions: ["open_people"],
    needsOperator: true,
  },
  invalid_booking_link: {
    cause: "It came from a CRM booking link that names a deal the CRM can't use.",
    nextStep: OPERATOR,
    actions: [],
    needsOperator: true,
  },
  previous_booking_missing: {
    cause: "It's a Calendly reschedule of a booking the CRM never added.",
    nextStep: "Recover the original booking first, then retry this one.",
    actions: ["retry"],
  },
  booking_not_tracked: {
    cause: "It belongs to a booking the CRM hasn't added yet.",
    nextStep: "It's added automatically once the original booking is.",
    actions: [],
  },
  historical_booking_requires_review: {
    cause: "A newer booking already changed this person's deal, so this older one can't be placed automatically.",
    nextStep: OPERATOR,
    actions: ["open_people"],
    needsOperator: true,
  },
  booking_history_requires_review: {
    cause: "This person has more deals than the CRM checks automatically.",
    nextStep: OPERATOR,
    actions: ["open_people"],
    needsOperator: true,
  },
  follow_up_history_requires_review: {
    cause: "The deal has more follow-ups than the CRM checks automatically.",
    nextStep: OPERATOR,
    actions: [],
    needsOperator: true,
  },
  booking_target_requires_review: {
    cause: "It reschedules a call whose deal has moved on.",
    nextStep: OPERATOR,
    actions: ["open_people"],
    needsOperator: true,
  },
  ambiguous_booking_target: {
    cause: "More than one deal could take this booking.",
    nextStep: OPERATOR,
    actions: ["open_people"],
    needsOperator: true,
  },
  ambiguous_follow_up: {
    cause: "More than one follow-up could take this booking.",
    nextStep: OPERATOR,
    actions: [],
    needsOperator: true,
  },
  ambiguous_booking_identity: {
    cause: "The CRM already has a different invitee on this Calendly event.",
    nextStep: OPERATOR,
    actions: [],
    needsOperator: true,
  },
  processing_failed: {
    cause: "The CRM hit an error while adding this booking.",
    nextStep: "Retry it. If it fails again, an operator has to look at the logs.",
    actions: ["retry"],
  },
  work_canceled: {
    cause: "Processing was canceled before it finished.",
    nextStep: "Retry it.",
    actions: ["retry"],
  },
};

export function holdNextStep(reason: string | undefined): HoldExplanation {
  const known = reason ? EXPLANATIONS[reason] : undefined;
  if (known) return { needsOperator: false, ...known };
  return {
    cause: reason ? `Held with code ${reason}.` : "Held with no reason recorded.",
    nextStep: OPERATOR,
    actions: ["retry"],
    needsOperator: true,
  };
}
