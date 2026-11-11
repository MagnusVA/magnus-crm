/**
 * What Jev is asked about a recorded call (docs/plans/closer-assistant.md
 * §6.9). Three questions never change. The fourth, `claim`, is the closer's
 * own record written as a sentence by a template below, so Jev rates the
 * claim itself rather than summarising the call.
 */

export const ATTENDANCE_CHOICES = {
  held: "The prospect joined and talked with the closer.",
  no_show: "The prospect never joined. Only the closer speaks, or the closer waits and leaves.",
  not_sales_call: "This was not a sales call with a prospect, such as a team meeting or a test.",
} as const;

export const ENDING_CHOICES = {
  paid: "The prospect paid, or gave payment details, during the call.",
  call_back: "The prospect didn't pay and agreed to talk again, or asked for time with a next step.",
  lost: "The prospect said no, or the closer ended the sale.",
  undecided: "The call ended with no decision and no next step.",
} as const;

export const OBJECTION_CHOICES = {
  partner: "They need a spouse, partner or business partner to agree first.",
  price: "The price or the payment terms.",
  timing: "Not now: cash flow, the season, or other commitments.",
  fit: "The program doesn't fit their business or their stage.",
  trust: "They doubt the program, the results, or the closer.",
  none: "They bought, or raised no objection.",
} as const;

export type AttendanceChoice = keyof typeof ATTENDANCE_CHOICES;
export type EndingChoice = keyof typeof ENDING_CHOICES;
export type ObjectionChoice = keyof typeof OBJECTION_CHOICES;

export type RecordKind = "payment" | "call_back" | "lost" | "no_show";

export type CallRecord = {
  kind: RecordKind;
  paymentType?: string;
  amountMinor?: number;
  currency?: string;
  lossReason?: string;
};

function money(amountMinor: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
    }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

function paymentShape(paymentType: string | undefined) {
  switch (paymentType) {
    case "pif":
      return "in full";
    case "deposit":
      return "as a deposit";
    case "split":
      return "as the first of several payments";
    case "monthly":
      return "as the first monthly payment";
    default:
      return "toward the program";
  }
}

/** The claim for each kind of record. A day-closed check has none. */
export function claimFor(record: CallRecord | undefined): string | undefined {
  if (!record) return undefined;
  switch (record.kind) {
    case "payment":
      return record.amountMinor !== undefined && record.currency
        ? `On this call the prospect agreed to buy and paid, gave payment details, or firmly committed to pay about ${money(record.amountMinor, record.currency)} ${paymentShape(record.paymentType)}. The money may arrive after the call, through a payment link or a financing provider, and in another currency.`
        : "On this call the prospect agreed to buy and paid, gave payment details, or firmly committed to pay. The money may arrive after the call.";
    case "call_back":
      return "The prospect agreed to talk again before deciding.";
    case "lost": {
      const reason = record.lossReason?.trim();
      return reason
        ? `The prospect turned the offer down, or the closer ended the sale, mainly because: ${reason.slice(0, 200)}.`
        : "The prospect turned the offer down, or the closer ended the sale.";
    }
    case "no_show":
      return "The prospect never joined the call.";
  }
}

export type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string };

const QUESTIONS = {
  attendance: {
    type: "choice",
    instructions: "Did the prospect attend this sales call?",
    criteria: { ...ATTENDANCE_CHOICES },
  },
  ending: {
    type: "choice",
    instructions: "How did the call end for the prospect?",
    criteria: { ...ENDING_CHOICES },
  },
  objection: {
    type: "choice",
    instructions: "What mainly kept the prospect from buying today?",
    criteria: { ...OBJECTION_CHOICES },
  },
} as const satisfies Record<string, DecisionQuestion>;

/** Every question in one `questions` body. */
export function buildQuestions(claim: string | undefined): Record<string, DecisionQuestion> {
  return {
    ...QUESTIONS,
    ...(claim ? { claim: { type: "noul" as const, instructions: claim } } : {}),
  };
}

export type QuestionGroup = "attendance" | "outcome" | "claim";

/**
 * One check asks small groups of questions in separate Decisions calls, so
 * each call weighs one thing: whether the prospect was there, how the call
 * ended and why, and whether the closer's record is true. The claim group
 * exists only when something was recorded.
 */
export function buildQuestionGroups(
  claim: string | undefined,
): Array<{ group: QuestionGroup; questions: Record<string, DecisionQuestion> }> {
  return [
    { group: "attendance", questions: { attendance: QUESTIONS.attendance } },
    {
      group: "outcome",
      questions: { ending: QUESTIONS.ending, objection: QUESTIONS.objection },
    },
    ...(claim
      ? [
          {
            group: "claim" as const,
            questions: { claim: { type: "noul" as const, instructions: claim } },
          },
        ]
      : []),
  ];
}
