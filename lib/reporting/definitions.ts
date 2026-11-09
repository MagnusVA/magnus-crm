// The reporting dictionary (docs/reviews/reports-overhaul.html §07). Every
// report page, Overview, Operations, help tips, export Definitions sheets and
// the metrics API's descriptions read a term from here, so a word means one
// thing everywhere. A term names its grain (what one unit is) and the time
// that puts it in a range.

export type TermCategory = "calls" | "deals" | "cash" | "people" | "time";

export type ReportTerm = {
  label: string;
  category: TermCategory;
  /** What one unit is. */
  grain: string;
  /** One or two plain sentences, for help tips and the Definitions sheet. */
  definition: string;
  /** The formula in words. */
  formula: string;
  /** The timestamp or rule that puts a unit in a range. */
  anchor: string;
};

export const REPORT_TERMS = {
  callsScheduled: {
    label: "Calls scheduled",
    category: "calls",
    grain: "call",
    definition: "Calls whose time falls in the range, without the slots that were moved.",
    formula: "meetings in range − moved slots",
    anchor: "meetings.scheduledAt",
  },
  bookingsMade: {
    label: "Bookings made",
    category: "calls",
    grain: "call",
    definition:
      "Calls someone booked during the range, whenever the call is. A meeting that replaces another, a move or a rebook after a no-show, doesn't count again. DM closers' bookings use the same rule.",
    formula: "meetings created in range − replacements",
    anchor: "meetings.createdAt; a replacement has rescheduledFromMeetingId",
  },
  followUpCall: {
    label: "Follow-up call",
    category: "calls",
    grain: "call",
    definition:
      "A call on a deal where the person has already held one. Everything before that is a first call, moves and rebooks after a no-show included.",
    formula: "a held call on the same deal is scheduled before it",
    anchor: "meetings.callClassification, re-checked when a result is recorded",
  },
  rebooked: {
    label: "Rebooked after a no-show",
    category: "calls",
    grain: "call",
    definition: "A call booked to replace one the person missed. It's a first call if the missed one was.",
    formula: "meetings whose replaced meeting is a no-show",
    anchor: "meetings.scheduledAt",
  },
  moved: {
    label: "Moved",
    category: "calls",
    grain: "call",
    definition: "A slot given up because the call was rescheduled. Another meeting points back at it.",
    formula: "canceled meetings with a successor",
    anchor: "meetings.scheduledAt",
  },
  canceled: {
    label: "Canceled",
    category: "calls",
    grain: "call",
    definition: "Calls in the range that were canceled and not moved.",
    formula: "canceled meetings − moved",
    anchor: "meetings.scheduledAt",
  },
  callsDue: {
    label: "Calls due",
    category: "calls",
    grain: "call",
    definition: "Calls whose time has passed and that weren't canceled or moved. Every one of them owes a result.",
    formula: "held + no-show + not recorded",
    anchor: "meetings.scheduledAt + durationMinutes in the past",
  },
  notRecorded: {
    label: "Not recorded",
    category: "calls",
    grain: "call",
    definition: "Calls due with no result yet: still scheduled after they ended.",
    formula: "calls due − held − no-show",
    anchor: "meetings.scheduledAt + durationMinutes in the past",
  },
  showRate: {
    label: "Show rate",
    category: "calls",
    grain: "call",
    definition: "Of the calls with a recorded result, the share where the person came. Always shown with Recorded beside it.",
    formula: "held ÷ (held + no-show)",
    anchor: "meetings.scheduledAt",
  },
  recorded: {
    label: "Recorded",
    category: "calls",
    grain: "call",
    definition: "How many of the calls that owed a result got one. A low figure means the show rate describes only part of the calls.",
    formula: "(held + no-show) ÷ calls due",
    anchor: "meetings.scheduledAt",
  },
  showRateFloor: {
    label: "Show-rate floor",
    category: "calls",
    grain: "call",
    definition: "The show rate if every unrecorded call was a no-show. The gap to Show rate is what the unrecorded calls could hide.",
    formula: "held ÷ calls due",
    anchor: "meetings.scheduledAt",
  },
  firstCallShowRate: {
    label: "First-call show rate",
    category: "calls",
    grain: "call",
    definition: "Show rate over first calls only: every attempt at a person's first conversation, moves and rebooks after a no-show included.",
    formula: "held first calls ÷ (held + no-show first calls)",
    anchor: "meetings.callClassification",
  },
  timeToRecord: {
    label: "Time to record",
    category: "time",
    grain: "call",
    definition: "How long after a call ended its result was recorded. The median per closer.",
    formula: "median(marked at − call end)",
    anchor: "heldMarkedAt or noShowMarkedAt, minus scheduledAt + durationMinutes",
  },
  closeRate: {
    label: "Close rate",
    category: "deals",
    grain: "deal",
    definition:
      "Of the deals whose first held call was in the range, the share that are won now. Credited to the closer who had that call and its booked program.",
    formula: "cohort deals won now ÷ deals with a first held call in range",
    anchor: "the first held call's scheduledAt; won is read now",
  },
  winRate: {
    label: "Win rate",
    category: "deals",
    grain: "deal",
    definition: "A closer's won deals over won and lost, counting only losses a person recorded. No-shows and cancellations stay out.",
    formula: "won ÷ (won + lost by a person)",
    anchor: "paymentReceivedAt or lostAt",
  },
  dealsWon: {
    label: "Deals won",
    category: "deals",
    grain: "deal",
    definition: "Distinct deals whose first payment was in the range.",
    formula: "count of distinct deals with their first payment in range",
    anchor: "opportunities.paymentReceivedAt",
  },
  cash: {
    label: "Cash",
    category: "cash",
    grain: "payment",
    definition: "Every payment that isn't disputed, deposits included, one total per currency. Never added across currencies.",
    formula: "Σ amount where status ≠ disputed, per currency",
    anchor: "paymentRecords.recordedAt",
  },
  finalCash: {
    label: "Final cash",
    category: "cash",
    grain: "payment",
    definition: "Cash without deposits. The figure that matches what a deal paid toward its program.",
    formula: "cash − deposits, per currency",
    anchor: "paymentRecords.recordedAt",
  },
  cashPerWonDeal: {
    label: "Cash per won deal",
    category: "cash",
    grain: "deal",
    definition: "Final cash from the deals won in the range, divided by those deals.",
    formula: "final cash on deals won in range ÷ deals won, per currency",
    anchor: "opportunities.paymentReceivedAt",
  },
  creditedCash: {
    label: "Credited cash",
    category: "cash",
    grain: "person × role",
    definition:
      "Cash on the deals where this person holds a credit in this role, in full for each person and counted once per deal. For phone closers it's the payments that name them. It records who contributed, never who is owed.",
    formula: "Σ cash on deals with a credit row for the person and role; closers: Σ cash on payments naming them",
    anchor: "paymentRecords.recordedAt; credit rows with attributedAt ≤ the payment",
  },
  shared: {
    label: "Shared",
    category: "cash",
    grain: "role",
    definition: "Cash counted for two or more people in the same role. People's rows add up to the lane plus this.",
    formula: "Σ people's credited cash − lane cash",
    anchor: "paymentRecords.recordedAt",
  },
  attributionCoverage: {
    label: "Attribution coverage",
    category: "cash",
    grain: "role",
    definition: "How much of the cash has someone credited in a role. The gap is cash no one in that role touched, or credit the system didn't record.",
    formula: "cash on deals with any credit in the role ÷ cash",
    anchor: "paymentRecords.recordedAt, per currency",
  },
  perScheduledHour: {
    label: "Per scheduled hour",
    category: "people",
    grain: "person × day",
    definition: "A count divided by the hours the person was scheduled, each day under the schedule in force that day.",
    formula: "count ÷ scheduled hours",
    anchor: "the schedule's effectiveFrom",
  },
  bookRate: {
    label: "Book rate",
    category: "people",
    grain: "deal",
    definition: "Of the deals a setter qualified in the range, the share that have a first booking by now.",
    formula: "qualified deals booked by now ÷ deals qualified in range",
    anchor: "the qualification's submittedAt",
  },
  tasksOnTime: {
    label: "Tasks on time",
    category: "people",
    grain: "task",
    definition: "Of the tasks due in the range, the share completed by their due time.",
    formula: "completed by due ÷ tasks due in range",
    anchor: "followUps due time",
  },
  speedToQualify: {
    label: "Speed to qualify",
    category: "time",
    grain: "person",
    definition: "Median time from a person entering In conversation to Qualified. Skipped stages are left out.",
    formula: "median(qualified at − in conversation at)",
    anchor: "leads.lifecycleStageEnteredAt",
  },
  bookingLeadTime: {
    label: "Booking lead time",
    category: "time",
    grain: "call",
    definition: "Median days between booking a first call and the call itself.",
    formula: "median(scheduledAt − createdAt)",
    anchor: "first calls",
  },
  salesCycle: {
    label: "Sales cycle",
    category: "time",
    grain: "deal",
    definition: "Median days from a deal's first touch to its first payment, using the touch frozen on the deal.",
    formula: "median(first payment − first touch)",
    anchor: "opportunities.paymentReceivedAt",
  },
} as const satisfies Record<string, ReportTerm>;

export type ReportTermKey = keyof typeof REPORT_TERMS;

export function reportTerm(key: ReportTermKey): ReportTerm {
  return REPORT_TERMS[key];
}

/** "Label: definition", for a help tip or a Definitions sheet row. */
export function termHelp(key: ReportTermKey): string {
  const term = REPORT_TERMS[key];
  return `${term.label}: ${term.definition}`;
}
