import type {
  NoShowTier,
  SuggestionKind,
  SuggestionTier,
} from "../../../lib/callInsights/taxonomy";
import type {
  AttendanceEvidence,
  EarlyReading,
  FoundQuote,
  ResultEvidence,
  SuggestionValues,
} from "../validators";

export const SUGGESTION_NOTE_CODES = [
  "models_disagree",
  "jev_missing",
  "jev_low_confidence",
  "code_checks_failed",
  "no_decision",
] as const;

type LabelledQuote = { label: string } & FoundQuote;
type ChoicePair = EarlyReading["attendance"];

function describeReading(pair: ChoicePair): string {
  const describe = (reading: NonNullable<ChoicePair>["withSummary"]) =>
    reading
      ? `${reading.choice}${reading.confidence === undefined ? "" : ` ${reading.confidence.toFixed(2)}`}`
      : "missing";
  const withSummary = describe(pair?.withSummary);
  const withoutSummary = describe(pair?.withoutSummary);
  return withSummary === withoutSummary
    ? withSummary
    : `${withSummary} / ${withoutSummary}`;
}

/** The words a card shows for each fixed result-quote label. Never the model's own text. */
const RESULT_QUOTE_TEXT: Record<string, string> = {
  price: "Price",
  agreement: "Agreement",
  payment: "Payment",
  timing: "Timing",
  decline: "Decline",
  other: "From the call",
};

/** Only the fields the result's own form has: a payment carries no call-back time. */
function valuesFor(kind: string, values: SuggestionValues): SuggestionValues {
  if (kind === "paid" || kind === "promised")
    return {
      amountMinor: values.amountMinor,
      currency: values.currency,
      currencyAssumed: values.currencyAssumed,
      paymentType: values.paymentType,
      programId: values.programId,
    };
  if (kind === "call_back")
    return {
      callbackAt: values.callbackAt,
      contactMethod: values.contactMethod,
    };
  if (kind === "lost") return { lossCategory: values.lossCategory };
  return {};
}

export function deriveSuggestion(a: {
  noShow: { tier: NoShowTier; notes: string[] };
  result?: ResultEvidence;
  attendance?: AttendanceEvidence;
  reading?: EarlyReading;
}): null | {
  kind: SuggestionKind;
  tier: SuggestionTier;
  noShowTier?: NoShowTier;
  values: SuggestionValues;
  quotes: LabelledQuote[];
  claudeReading?: string;
  jevReading?: string;
  notes: string[];
} {
  if (a.noShow.tier !== "none") {
    const noShowTier = a.noShow.tier;
    const tier: SuggestionTier =
      noShowTier === "certain" || noShowTier === "review"
        ? "ready"
        : noShowTier === "check"
          ? "check"
          : "unconfirmed";
    const quotes: LabelledQuote[] = [];
    const carry = (found: FoundQuote[] | undefined, label: string) => {
      quotes.push(...(found ?? []).map((quote) => ({ ...quote, label })));
    };
    carry(a.attendance?.waiting, "Waiting");
    carry(a.attendance?.leaving, "Leaving");
    carry(a.attendance?.triedToReach, "Tried to reach them");
    if (tier === "check") {
      carry(a.attendance?.someoneThere, "Someone is there");
      carry(a.attendance?.secondPerson, "Someone is there");
    }
    return {
      kind: noShowTier === "empty" ? "empty_recording" : "no_show",
      tier,
      noShowTier,
      values:
        tier === "ready"
          ? { noShowReason: a.attendance?.suggestedReason ?? "no_response" }
          : {},
      quotes,
      ...(a.attendance ? { claudeReading: a.attendance.reading } : {}),
      jevReading: describeReading(a.reading?.attendance),
      notes: [...a.noShow.notes],
    };
  }
  const result = a.result;
  if (!result || result.kind === "none") return null;
  const base = {
    kind: result.kind,
    quotes: result.quotes.map((quote) => ({
      ...quote,
      label: RESULT_QUOTE_TEXT[quote.label] ?? RESULT_QUOTE_TEXT.other,
    })),
    claudeReading: result.kind === "paid" ? "payment" : result.kind,
    jevReading: describeReading(a.reading?.ending),
  };
  if (result.kind === "no_decision") {
    return { ...base, tier: "unconfirmed", values: {}, notes: ["no_decision"] };
  }
  const expected = result.kind === "promised" ? "paid" : result.kind;
  const endings = [
    a.reading?.ending?.withSummary,
    a.reading?.ending?.withoutSummary,
  ];
  const attendance = [
    a.reading?.attendance?.withSummary,
    a.reading?.attendance?.withoutSummary,
  ];
  const conflicts =
    endings.some(
      (reading) =>
        reading &&
        ["paid", "call_back", "lost"].includes(reading.choice) &&
        reading.choice !== expected &&
        (reading.confidence ?? 0) >= 0.6,
    ) ||
    attendance.some(
      (reading) =>
        reading?.choice === "no_show" && (reading.confidence ?? 0) >= 0.6,
    );
  if (conflicts)
    return { ...base, tier: "check", values: {}, notes: ["models_disagree"] };

  const notes: string[] = [...result.failedChecks];
  if (!result.codeChecksPassed) notes.push("code_checks_failed");
  if (
    endings.some((reading) => !reading || reading.confidence === undefined) ||
    attendance.some((reading) => !reading) ||
    // Jev is asked about the result only once the code's checks pass.
    (result.codeChecksPassed && a.reading?.resultCheck === undefined)
  )
    notes.push("jev_missing");
  const agrees =
    endings.every(
      (reading) =>
        reading?.choice === expected && (reading.confidence ?? 0) >= 0.8,
    ) &&
    attendance.every((reading) => reading?.choice === "held") &&
    (a.reading?.resultCheck ?? 0) >= 0.8;
  // When the code's checks failed, they are the reason; Jev's result check
  // was never asked, so its absence says nothing about Jev's confidence.
  if (!agrees && result.codeChecksPassed && !notes.includes("jev_missing"))
    notes.push("jev_low_confidence");
  const tier: SuggestionTier =
    result.codeChecksPassed && agrees ? "ready" : "unconfirmed";
  return {
    ...base,
    tier,
    values: tier === "ready" ? valuesFor(result.kind, result.values) : {},
    notes,
  };
}
