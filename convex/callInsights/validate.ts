import type { Infer } from "convex/values";
import { businessDayStart } from "../../lib/businessDay";
import {
  isCategory,
  LOSS_CATEGORIES,
  type ItemKind,
} from "../../lib/callInsights/taxonomy";
import { parseAmounts, incomeBandFor } from "./income";
import type { RawExtraction, RawAttendance } from "./parse";
import {
  containsCardNumber,
  normalizeForMatch,
  type PreparedLine,
  type PreparedTranscript,
} from "./transcriptPrep";
import type {
  InsightItem,
  ResultEvidence,
  AttendanceEvidence,
  FoundQuote,
  droppedCountsValidator,
} from "./validators";

export type DroppedCounts = Infer<typeof droppedCountsValidator>;
const emptyDropped = (): DroppedCounts => ({
  quoteNotFound: 0,
  notProspect: 0,
  amountNotInQuote: 0,
  badCategory: 0,
  cardNumber: 0,
  overLimit: 0,
});
type Citation = { quote: string; lineIndex: number };
function findQuote(
  raw: Citation,
  lines: PreparedLine[],
  dropped: DroppedCounts,
): { quote: FoundQuote; line: PreparedLine } | undefined {
  if (raw.quote.length > 400) {
    dropped.overLimit++;
    return;
  }
  // Whole words only: "170" must not match inside "1,700", nor "pay" inside "payment".
  const needle = normalizeForMatch(raw.quote);
  const line = needle
    ? [raw.lineIndex, raw.lineIndex - 1, raw.lineIndex + 1]
        .map((index) => lines.find((line) => line.index === index))
        .find(
          (line) =>
            line && ` ${normalizeForMatch(line.text)} `.includes(` ${needle} `),
        )
    : undefined;
  if (!line) {
    dropped.quoteNotFound++;
    return;
  }
  if (containsCardNumber(line.text)) {
    dropped.cardNumber++;
    return;
  }
  return {
    line,
    quote: {
      quote: raw.quote,
      lineIndex: line.index,
      atSeconds: line.atSeconds,
      speaker: line.role,
    },
  };
}
function limit<T>(list: T[], max: number, dropped: DroppedCounts): T[] {
  dropped.overLimit += Math.max(0, list.length - max);
  return list.slice(0, max);
}
function currencyFor(value?: string): {
  currency?: string;
  currencyAssumed?: boolean;
} {
  if (value === "dollars_unspecified")
    return { currency: "USD", currencyAssumed: true };
  if (
    value &&
    ["usd", "cad", "aud", "eur", "gbp", "hnl", "mxn"].includes(
      value.toLowerCase(),
    )
  )
    return { currency: value.toUpperCase() };
  return {};
}
const minor = (amount: string | undefined): number | undefined => {
  if (amount === undefined || !/^\d+(?:\.\d+)?$/.test(amount)) return undefined;
  const result = Math.round(Number(amount) * 100);
  return Number.isSafeInteger(result) ? result : undefined;
};
const saysAmount = (text: string, amountMinor: number) =>
  parseAmounts(text).some((value) => Math.round(value * 100) === amountMinor);
/**
 * The amount must be said on the transcript line the quote was found on, and
 * in the quoted words themselves. The line is the authority: the model's copy
 * of a quote can lose a decimal point or a comma ("997.50" quoted as "99750").
 */
const amountFound = (
  lineText: string,
  quoteText: string,
  amountMinor: number,
) => saysAmount(lineText, amountMinor) && saysAmount(quoteText, amountMinor);
/** Words that mark a line as talking about what is being paid. Compared after accents are stripped. */
const PAYMENT_WORDS = new Set([
  "pay",
  "paying",
  "paid",
  "payment",
  "payments",
  "deposit",
  "price",
  "total",
  "pago",
  "pagos",
  "pagar",
  "pagare",
  "abono",
  "abonar",
  "cuota",
  "cuotas",
  "deposito",
  "enganche",
  "precio",
]);
const mentionsPayment = (text: string) =>
  normalizeForMatch(text)
    .split(" ")
    .some((word) => PAYMENT_WORDS.has(word));
function moneyFields(
  min: number,
  max: number | undefined,
  period: string | undefined,
) {
  const factor =
    period === "week"
      ? 52 / 12
      : period === "month"
        ? 1
        : period === "year"
          ? 1 / 12
          : undefined;
  return {
    minMinor: min,
    ...(max !== undefined ? { maxMinor: max } : {}),
    ...(factor !== undefined
      ? {
          monthlyMinMinor: Math.round(min * factor),
          ...(max !== undefined
            ? { monthlyMaxMinor: Math.round(max * factor) }
            : {}),
        }
      : {}),
  };
}
const suggestedReason = (raw: RawAttendance) =>
  raw.reachOutcome === "cant_make_it"
    ? ("late_cancel" as const)
    : raw.reachOutcome === "trouble_joining"
      ? ("technical_issues" as const)
      : ("no_response" as const);
const attendanceLists = [
  "waiting",
  "leaving",
  "triedToReach",
  "someoneThere",
  "secondPerson",
  "notSalesCall",
] as const;
function attendance(
  raw: RawAttendance,
  t: PreparedTranscript,
  dropped: DroppedCounts,
  timing?: { start: number; length: number },
): AttendanceEvidence {
  const result: AttendanceEvidence = {
    reading: raw.reading,
    waiting: [],
    leaving: [],
    triedToReach: [],
    someoneThere: [],
    secondPerson: [],
    notSalesCall: [],
    suggestedReason: suggestedReason(raw),
  };
  for (const key of attendanceLists) {
    for (const citation of limit(raw[key], 6, dropped)) {
      const found = findQuote(citation, t.lines, dropped);
      if (!found) continue;
      if (
        ["waiting", "leaving", "triedToReach"].includes(key) &&
        !found.line.isCloserKey
      ) {
        dropped.notProspect++;
        continue;
      }
      if (
        timing &&
        key === "waiting" &&
        found.line.atSeconds < timing.start + 300
      )
        continue;
      if (
        timing &&
        key === "leaving" &&
        (found.line.atSeconds < timing.length - 120 ||
          found.line.atSeconds > timing.length)
      )
        continue;
      result[key].push(found.quote);
    }
  }
  return result;
}
export function validateAttendance(
  raw: RawAttendance,
  t: PreparedTranscript,
  scheduledStartOffsetSeconds: number,
  recordingLengthSeconds: number,
): AttendanceEvidence {
  return attendance(raw, t, emptyDropped(), {
    start: scheduledStartOffsetSeconds,
    length: recordingLengthSeconds,
  });
}

/** Reuse business-day conversion so overlaps and gaps follow the tenant's existing policy. */
function callbackAt(
  local: string | undefined,
  timeZone: string,
): number | undefined {
  if (!local) return undefined;
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
      local,
    );
  if (
    !match ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4] ?? 0) > 59
  )
    return undefined;
  try {
    return (
      businessDayStart(match[1], { timeZone, dayStartHour: Number(match[2]) }) +
      Number(match[3]) * 60_000 +
      Number(match[4] ?? 0) * 1000 +
      Number((match[5] ?? "").padEnd(3, "0"))
    );
  } catch {
    return undefined;
  }
}
function validateResult(
  raw: RawExtraction["result"],
  t: PreparedTranscript,
  o: { timeZone: string; now: number },
  dropped: DroppedCounts,
  reach: RawAttendance,
): ResultEvidence {
  const quotes: ResultEvidence["quotes"] = [];
  // The transcript line each surviving quote was found on, in the same order.
  const quoteLines: PreparedLine[] = [];
  for (const citation of limit(raw.quotes, 6, dropped)) {
    const found = findQuote(citation, t.lines, dropped);
    if (!found) continue;
    quotes.push({ ...found.quote, label: citation.label });
    quoteLines.push(found.line);
  }
  const amount = minor(raw.amount);
  const at = callbackAt(raw.callbackDateTimeLocal, o.timeZone);
  const loss =
    raw.lossCategory && Object.hasOwn(LOSS_CATEGORIES, raw.lossCategory)
      ? (raw.lossCategory as keyof typeof LOSS_CATEGORIES)
      : undefined;
  const values: ResultEvidence["values"] = {
    ...currencyFor(raw.currencyAsSaid),
    noShowReason: suggestedReason(reach),
    ...(amount !== undefined ? { amountMinor: amount } : {}),
    ...(raw.paymentType ? { paymentType: raw.paymentType } : {}),
    ...(at !== undefined ? { callbackAt: at } : {}),
    ...(raw.kind === "call_back"
      ? { contactMethod: raw.contactMethod ?? "call" }
      : {}),
    ...(loss ? { lossCategory: loss } : {}),
  };
  const failedChecks: string[] = [];
  if (raw.kind === "none" || raw.kind === "no_decision")
    failedChecks.push("no_actionable_result");
  if (!quotes.length) failedChecks.push("no_quotes");
  if (raw.kind === "paid" || raw.kind === "promised") {
    const prospect = quotes
      .map((quote, i) => ({ quote, line: quoteLines[i] }))
      .filter((found) => found.quote.speaker === "Prospect");
    if (!prospect.length) failedChecks.push("no_prospect_agreement");
    // A payment of nothing is no payment.
    if (
      amount === undefined ||
      amount <= 0 ||
      !quotes.some((quote, i) =>
        amountFound(quoteLines[i].text, quote.quote, amount),
      )
    )
      failedChecks.push("amount_not_in_quote");
    if (raw.amountRole !== "this_payment") failedChecks.push("amount_role");
    if (t.speakerUncertain) failedChecks.push("speaker_unclear");
    // Anything said after the prospect agreed can change the deal, whether the
    // model cited it or not: a later line that talks about paying and names a
    // different amount fails the check. The agreement is the prospect's first
    // quote that says the amount, else their first quote.
    const agreed =
      amount === undefined
        ? undefined
        : (
            prospect.find((found) => saysAmount(found.line.text, amount)) ??
            prospect[0]
          )?.line;
    if (
      amount !== undefined &&
      agreed &&
      t.lines.some(
        (line) =>
          line.index > agreed.index &&
          mentionsPayment(line.text) &&
          parseAmounts(line.text).some(
            (value) => Math.round(value * 100) !== amount,
          ),
      )
    )
      failedChecks.push("later_amount");
  }
  if (raw.kind === "call_back" && (at === undefined || at <= o.now))
    failedChecks.push("callback_not_future");
  if (raw.kind === "lost" && !loss) failedChecks.push("bad_loss_category");
  return {
    kind: raw.kind,
    quotes,
    values,
    ...(raw.programHeard ? { programHeard: raw.programHeard } : {}),
    codeChecksPassed: failedChecks.length === 0,
    failedChecks,
  };
}

export function validateExtraction(
  raw: RawExtraction,
  t: PreparedTranscript,
  o: { timeZone: string; now: number },
): {
  items: InsightItem[];
  dropped: DroppedCounts;
  primaryBlockerExtracted?: string;
  speakerUncertain: boolean;
  result: ResultEvidence;
  attendance: AttendanceEvidence;
} {
  const dropped = emptyDropped();
  const items: InsightItem[] = [];
  function base(
    kind: ItemKind,
    category: string,
    candidate: Citation & { statement: string },
  ): InsightItem | undefined {
    if (!isCategory(kind, category)) {
      dropped.badCategory++;
      return;
    }
    if (candidate.statement.length > 200) {
      dropped.overLimit++;
      return;
    }
    const found = findQuote(candidate, t.lines, dropped);
    if (!found) return;
    if (found.line.role !== "Prospect") {
      dropped.notProspect++;
      return;
    }
    return {
      key: "",
      kind,
      category,
      statement: candidate.statement.replace(/[\r\n]+/g, " "),
      quote: found.quote.quote,
      lineIndex: found.line.index,
      atSeconds: found.line.atSeconds,
      check: "unchecked",
    };
  }
  /** True when the item's line and its quote both say the amount. */
  const itemSays = (item: InsightItem, amountMinor: number) =>
    amountFound(
      t.lines.find((line) => line.index === item.lineIndex)?.text ?? "",
      item.quote,
      amountMinor,
    );
  function add(item: InsightItem) {
    item.key = `${item.kind}:${items.filter((other) => other.kind === item.kind).length}`;
    items.push(item);
  }
  for (const candidate of limit(raw.objections, 12, dropped)) {
    const item = base("objection", candidate.category, candidate);
    if (!item) continue;
    item.resolution = candidate.resolution;
    if (candidate.resolution === "resolved") {
      const resolution =
        candidate.resolutionQuote && candidate.resolutionLineIndex !== undefined
          ? findQuote(
              {
                quote: candidate.resolutionQuote,
                lineIndex: candidate.resolutionLineIndex,
              },
              t.lines,
              dropped,
            )
          : undefined;
      if (
        resolution &&
        resolution.line.role === "Prospect" &&
        resolution.line.index >= item.lineIndex
      ) {
        item.resolutionQuote = resolution.quote.quote;
        item.resolutionLineIndex = resolution.line.index;
      } else item.resolution = "unknown";
    }
    add(item);
  }
  for (const candidate of limit(raw.struggles, 10, dropped)) {
    const item = base("struggle", candidate.category, candidate);
    if (item) add(item);
  }
  for (const candidate of limit(raw.goals, 10, dropped)) {
    const item = base("goal", candidate.category, candidate);
    if (!item) continue;
    if (candidate.deadline) item.deadline = candidate.deadline;
    if (candidate.targetAmount !== undefined) {
      const min = minor(candidate.targetAmount),
        max = minor(candidate.targetAmountMax);
      if (
        min === undefined ||
        !itemSays(item, min) ||
        (candidate.targetAmountMax !== undefined &&
          (max === undefined || max < min || !itemSays(item, max)))
      ) {
        dropped.amountNotInQuote++;
        continue;
      }
      Object.assign(
        item,
        moneyFields(min, max, candidate.targetPeriod),
        currencyFor(candidate.targetCurrency),
        { scenario: "target" },
      );
      if (candidate.targetPeriod) item.period = candidate.targetPeriod;
    }
    add(item);
  }
  for (const candidate of limit(raw.income, 12, dropped)) {
    const item = base("income", candidate.kind, candidate);
    if (!item) continue;
    const min = minor(candidate.amountMin),
      max = minor(candidate.amountMax);
    if (
      min === undefined ||
      !itemSays(item, min) ||
      (candidate.amountMax !== undefined &&
        (max === undefined || max < min || !itemSays(item, max)))
    ) {
      dropped.amountNotInQuote++;
      continue;
    }
    Object.assign(
      item,
      moneyFields(min, max, candidate.period),
      currencyFor(candidate.currencyAsSaid),
      { scenario: candidate.scenario, period: candidate.period },
    );
    const band = incomeBandFor(
      candidate.kind,
      item.currency,
      item.monthlyMinMinor,
      item.monthlyMaxMinor,
      t.speakerUncertain,
    );
    if (band !== undefined) item.band = band;
    add(item);
  }
  const primary = items.some(
    (item) => item.kind === "objection" && item.category === raw.primaryBlocker,
  )
    ? raw.primaryBlocker
    : undefined;
  return {
    items,
    dropped,
    ...(primary ? { primaryBlockerExtracted: primary } : {}),
    speakerUncertain: t.speakerUncertain,
    result: validateResult(raw.result, t, o, dropped, raw.attendance),
    attendance: attendance(raw.attendance, t, dropped),
  };
}
