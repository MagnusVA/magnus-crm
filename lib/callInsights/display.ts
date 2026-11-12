/**
 * Words for the Call insights cards on the meeting page: the suggested
 * result's headline, income and goal lines, why a call wasn't read, and which
 * prefilled fields a person changed. Pure, so the cards and the tests share
 * them. Nothing here logs or sends what it formats.
 */
import type {
  RunReason,
  SuggestionValues,
} from "../../convex/callInsights/validators";
import {
  LOSS_CATEGORIES,
  type IncomePeriod,
  type IncomeScenario,
  type NoShowTier,
  type Resolution,
  type SuggestionKind,
  type SuggestionTier,
} from "./taxonomy";

// ─── Money ──────────────────────────────────────────────────────────────────

const plainNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});
const plainCents = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "1,700" for 170000 minor units, "1,700.50" when there are cents. No currency. */
export function formatMinorPlain(minor: number): string {
  const major = minor / 100;
  return minor % 100 === 0
    ? plainNumber.format(major)
    : plainCents.format(major);
}

/** The amount field's text for minor units: "1700", or "1700.5". */
export function minorToInput(minor: number): string {
  return String(minor / 100);
}

/** "USD", "USD (assumed)", or null when no currency was said. */
export function currencyWord(
  currency?: string,
  currencyAssumed?: boolean,
): string | null {
  if (!currency) return null;
  return currencyAssumed ? `${currency} (assumed)` : currency;
}

const PERIOD_WORDS: Record<IncomePeriod, string | null> = {
  week: "a week",
  month: "a month",
  year: "a year",
  hour: "an hour",
  per_session: "a session",
  one_off: "one time",
  point_in_time: null,
  unknown: null,
};

type MoneyFields = {
  scenario?: IncomeScenario;
  period?: IncomePeriod;
  currency?: string;
  currencyAssumed?: boolean;
  minMinor?: number;
  maxMinor?: number;
};

/**
 * "about 6,000 USD a month", "4,000 to 7,000 USD a month", "at least 10,000".
 * `approx` puts "about" before a single amount, as income figures said on a
 * call are. Null when no amount was said.
 */
export function moneyPhrase(
  money: MoneyFields,
  { approx = false } = {},
): string | null {
  const { minMinor, maxMinor } = money;
  if (minMinor === undefined) return null;
  let amount: string;
  if (maxMinor === undefined) amount = `at least ${formatMinorPlain(minMinor)}`;
  else if (maxMinor === minMinor)
    amount = `${approx ? "about " : ""}${formatMinorPlain(minMinor)}`;
  else
    amount = `${formatMinorPlain(minMinor)} to ${formatMinorPlain(maxMinor)}`;
  const currency = currencyWord(money.currency, money.currencyAssumed);
  const period = money.period ? PERIOD_WORDS[money.period] : null;
  return [amount, currency, period].filter(Boolean).join(" ");
}

/**
 * One income row: "Business revenue · about 6,000 USD a month", with
 * "target" when it is a goal figure and "currency not stated" when no
 * currency was said.
 */
export function incomeLine(item: MoneyFields & { label: string }): string {
  const parts = [item.label];
  const money = moneyPhrase(item, { approx: true });
  if (money) parts.push(money);
  if (item.scenario === "target") parts.push("target");
  if (money && !item.currency) parts.push("currency not stated");
  return parts.join(" · ");
}

/** One goal row: "Revenue growth · 15,000 USD a month · by summer". */
export function goalLine(
  item: MoneyFields & { label: string; deadline?: string },
): string {
  const parts = [item.label];
  const money = moneyPhrase(item);
  if (money) parts.push(money);
  if (item.deadline) parts.push(item.deadline);
  return parts.join(" · ");
}

/** An objection's resolution as the row shows it; nothing when unknown. */
export function resolutionWord(
  resolution?: Resolution,
): "Open" | "Resolved" | null {
  if (resolution === "unresolved") return "Open";
  if (resolution === "resolved") return "Resolved";
  return null;
}

// ─── Not read ───────────────────────────────────────────────────────────────

export const NOT_READ_REASONS: Record<RunReason, string> = {
  disabled: "Call insights was off when this call was matched.",
  cap_reached: "The monthly limit was reached.",
  no_transcript: "There is no transcript, or it has expired.",
  other_prospect: "The recording is another prospect's call.",
  no_prospect_speech: "Nobody but the closer spoke.",
  not_sales_call: "The call was marked not a sales call.",
  input_too_large: "The call is too long to read.",
  format_changed: "The model's answer could not be used.",
  refused: "The model declined to read this call.",
  upstream_error: "The AI Gateway didn't answer after several tries.",
  rejected: "The AI Gateway refused the request.",
  recording_moved: "The recording was moved to another meeting.",
  superseded: "A newer reading replaced this one.",
  lease_expired: "The reading stopped before it finished.",
  canceled: "The reading was canceled.",
};

/** Why a call wasn't read, in words. */
export function notReadReason(reason?: RunReason): string {
  return reason ? NOT_READ_REASONS[reason] : "No reason was recorded.";
}

/** "Sonnet 5.5" for "anthropic/claude-sonnet-5.5". */
export function modelLabel(model: string): string {
  const name = model.split("/").pop() ?? model;
  const words = name
    .replace(/^claude-/, "")
    .split("-")
    .filter(Boolean);
  if (words.length === 0) return model;
  return words
    .map((word, i) => (i === 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/** "$0.03", or "under $0.01". */
export function costLabel(usd: number): string {
  if (usd > 0 && usd < 0.005) return "under $0.01";
  return `$${usd.toFixed(2)}`;
}

// ─── Suggested result ───────────────────────────────────────────────────────

export const TIER_BADGES: Record<SuggestionTier, string> = {
  ready: "Confirmed by Jev",
  check: "Check this",
  unconfirmed: "Not confirmed",
};

const PAYMENT_TYPE_WORDS: Record<
  NonNullable<SuggestionValues["paymentType"]>,
  string
> = {
  monthly: "monthly",
  split: "split",
  pif: "paid in full",
  deposit: "deposit",
};

/**
 * What a reading heard, by its first word: Claude's result kind or attendance
 * reading, or Jev's choice. Jev's readings carry a confidence ("paid 0.92"),
 * which is dropped: the card shows labels, never scores.
 */
const READING_WORDS: Record<string, string> = {
  payment: "a payment",
  paid: "a payment",
  promised: "a promise to pay",
  call_back: "a call back",
  lost: "a lost deal",
  no_decision: "no decision",
  undecided: "no decision",
  absent: "a no-show",
  no_show: "a no-show",
  present: "a held call",
  held: "a held call",
  not_sales_call: "not a sales call",
  unclear: "nothing clear",
};

/** A reading in words: "a payment", "a call back"; null when missing or unknown. */
export function readingWords(reading?: string): string | null {
  if (!reading) return null;
  // Jev's two readings come as "paid 0.91 / call_back 0.70" when they differ.
  const choices = [
    ...new Set(
      reading
        .split("/")
        .map((part) => part.trim().split(/\s+/)[0])
        .filter((choice) => choice && choice !== "missing"),
    ),
  ];
  const words = choices.map((choice) => READING_WORDS[choice]).filter(Boolean);
  if (words.length === 0) return null;
  return words.length === 1 ? words[0] : `${words[0]} or ${words[1]}`;
}

/** "Claude heard a payment, Jev heard a call back". Null when neither is known. */
export function readingsLine(
  claudeReading?: string,
  jevReading?: string,
): string | null {
  const claude = readingWords(claudeReading);
  const jev = readingWords(jevReading);
  if (!claude && !jev) return null;
  return [
    claude ? `Claude heard ${claude}` : "Claude gave no clear reading",
    jev ? `Jev heard ${jev}` : "Jev didn't answer",
  ].join(", ");
}

type HeadlineSuggestion = {
  kind: SuggestionKind;
  tier: SuggestionTier;
  noShowTier?: NoShowTier;
  values: SuggestionValues;
  amountHintMinor?: number;
  programName?: string;
  claudeReading?: string;
  jevReading?: string;
};

/**
 * The suggestion's one-line heading: "Won · 1,700 USD now · split · Scale
 * Accelerator", "Call back · Thu Nov 13, 3:00 PM", "Probably a no-show".
 * Unknown parts are left out. `when` formats the call-back time in the
 * viewer's time zone.
 */
export function suggestionHeadline(
  s: HeadlineSuggestion,
  when: (at: number) => string,
): string {
  if (s.tier === "check") {
    const claude = readingWords(s.claudeReading);
    const jev = readingWords(s.jevReading);
    const readings = [
      ...new Set([claude, jev].filter((word): word is string => !!word)),
    ];
    return readings.length
      ? `Check this · ${readings.join(" or ")}`
      : "Check this";
  }
  const amountMinor = s.amountHintMinor ?? s.values.amountMinor;
  const amount =
    amountMinor !== undefined
      ? [
          formatMinorPlain(amountMinor),
          currencyWord(s.values.currency, s.values.currencyAssumed),
        ]
          .filter(Boolean)
          .join(" ")
      : null;
  switch (s.kind) {
    case "paid":
      return [
        "Won",
        amount ? `${amount} now` : null,
        s.values.paymentType ? PAYMENT_TYPE_WORDS[s.values.paymentType] : null,
        s.programName ?? null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "promised":
      return ["Promised to pay", amount].filter(Boolean).join(" · ");
    case "call_back":
      return s.values.callbackAt !== undefined
        ? `Call back · ${when(s.values.callbackAt)}`
        : "Call back";
    case "lost":
      return s.values.lossCategory
        ? `Lost · ${LOSS_CATEGORIES[s.values.lossCategory]}`
        : "Lost";
    case "no_show":
      if (s.noShowTier === "certain") return "No-show · only you spoke";
      if (s.noShowTier === "review") return "Probably a no-show";
      return "Possibly a no-show";
    case "empty_recording":
      return "Empty recording · listen first";
    case "no_decision":
      return "No decision on the call";
  }
}

/** Short sentences for the note codes a person can act on. Other codes aren't shown. */
const NOTE_SENTENCES: Record<string, string> = {
  models_disagree:
    "Claude and Jev read the call differently. Listen before you choose.",
  jev_missing: "Jev didn't answer, so nothing is filled.",
  speaker_unclear: "The recording doesn't make clear who is speaking.",
  amount_not_in_quote: "The amount isn't in the quoted lines.",
  amount_role: "The amount heard may be the full price, not this payment.",
  later_amount: "A different amount comes up later in the call.",
  no_prospect_agreement: "The prospect's agreement isn't in the quoted lines.",
  callback_not_future: "The call-back time heard has already passed.",
  not_closer_only: "Someone besides the closer speaks on the recording.",
  answer_like_pairs:
    "Short replies follow the closer's questions, so someone may have answered.",
  other_recording: "There is another recording around this time.",
  weak_match: "The recording was matched by time only.",
  late_start:
    "The recording started more than 3 minutes after the call's start.",
  empty_recording: "The recording has no transcript lines. Listen to it first.",
};

export function noteSentences(notes: string[]): string[] {
  return [
    ...new Set(notes.map((code) => NOTE_SENTENCES[code]).filter(Boolean)),
  ];
}

const SPEAKER_LETTER = { Closer: "C", Prospect: "P", Other: "O" } as const;

/** `31:52 · P: "Okay, I'll put it on my card."`, or without a speaker. */
export function quoteLine(
  at: string,
  quote: string,
  speaker?: keyof typeof SPEAKER_LETTER,
): string {
  return `${at} · ${speaker ? `${SPEAKER_LETTER[speaker]}: ` : ""}“${quote}”`;
}

// ─── Changed fields ─────────────────────────────────────────────────────────

type FieldValue = string | number | boolean | undefined | null;

/**
 * The names of prefilled fields whose submitted value differs from the
 * prefill. Only fields the prefill set count; empty strings and undefined are
 * the same "nothing". Names, never values, leave the form.
 */
export function changedFields(
  prefilled: Record<string, FieldValue>,
  submitted: Record<string, FieldValue>,
): string[] {
  const blank = (value: FieldValue) =>
    value === undefined || value === null || value === "";
  return Object.keys(prefilled)
    .filter((name) => !blank(prefilled[name]))
    .filter((name) => {
      const before = prefilled[name];
      const after = submitted[name];
      if (blank(after)) return true;
      return String(before) !== String(after);
    })
    .sort();
}
