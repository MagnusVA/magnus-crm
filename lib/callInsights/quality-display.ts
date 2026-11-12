/**
 * Words and small rules for the Call insights Quality tab: quality tests,
 * grading one call, the bars, Opus's calibration and the no-show wait. Pure,
 * so the tab and the tests share them. Nothing here logs or sends what it
 * formats.
 */
import type { SuggestionValues } from "../../convex/callInsights/validators";
import { moneyPhrase, formatMinorPlain, currencyWord } from "./display";
import {
  LOSS_CATEGORIES,
  categoryLabel,
  type IncomePeriod,
  type IncomeScenario,
  type ItemKind,
  type NoShowReason,
  type Resolution,
  type SuggestionKind,
} from "./taxonomy";

// ─── Splits and statuses ────────────────────────────────────────────────────

export type EvalSplit =
  | "dev"
  | "calib"
  | "holdout"
  | "drift_random"
  | "drift_risk";
export type EvalStatus =
  | "to_read"
  | "list_committed"
  | "labels_committed"
  | "closed";

/** The three splits a quality test fills, in the order it fills them. */
export const TEST_SPLITS = ["dev", "calib", "holdout"] as const;
export type TestSplit = (typeof TEST_SPLITS)[number];

const SPLIT_WORDS: Record<EvalSplit, string> = {
  dev: "Development",
  calib: "Calibration",
  holdout: "Holdout",
  drift_random: "Drift, random",
  drift_risk: "Drift, risky",
};

export function splitWords(split: string): string {
  return (SPLIT_WORDS as Record<string, string>)[split] ?? split;
}

const STATUS_WORDS: Record<EvalStatus, string> = {
  to_read: "To read",
  list_committed: "List done",
  labels_committed: "Graded",
  closed: "Closed",
};

export function caseStatusWords(status: string): string {
  return (STATUS_WORDS as Record<string, string>)[status] ?? status;
}

/** Status word tone: what the admin still owes is amber, graded is ink, closed is slate. */
export function caseStatusTone(status: string): "owed" | "live" | "done" {
  if (status === "to_read" || status === "list_committed") return "owed";
  if (status === "labels_committed") return "live";
  return "done";
}

/** "Grade" while there is grading to do, "Open" once it is graded. */
export function caseActionWords(status: string): "Grade" | "Open" {
  return status === "to_read" || status === "list_committed" ? "Grade" : "Open";
}

/** A campaign's progress from its status counts: to read, list done, graded (closed counts as graded). */
export function campaignProgress(statuses: Record<string, number>) {
  return {
    toRead: statuses.to_read ?? 0,
    listDone: statuses.list_committed ?? 0,
    graded: (statuses.labels_committed ?? 0) + (statuses.closed ?? 0),
  };
}

/** Campaign keys end in their UTC start date; newest first, then by name. */
export function sortCampaigns<T extends { campaign: string }>(
  campaigns: readonly T[],
): T[] {
  const date = (key: string) => /(\d{4}-\d{2}-\d{2})$/.exec(key)?.[1] ?? "";
  return [...campaigns].sort((a, b) => {
    const byDate = date(b.campaign).localeCompare(date(a.campaign));
    return byDate !== 0 ? byDate : a.campaign.localeCompare(b.campaign);
  });
}

// ─── Items ──────────────────────────────────────────────────────────────────

export type ItemClass = ItemKind | "result" | "attendance";

const ITEM_CLASS_WORDS: Record<ItemClass, string> = {
  objection: "Objection",
  struggle: "Struggle",
  goal: "Goal",
  income: "Income",
  result: "Suggested result",
  attendance: "No-show",
};

export function itemClassWords(itemClass: string): string {
  return (ITEM_CLASS_WORDS as Record<string, string>)[itemClass] ?? itemClass;
}

export function isExtractionClass(itemClass: string): itemClass is ItemKind {
  return (
    itemClass === "objection" ||
    itemClass === "struggle" ||
    itemClass === "goal" ||
    itemClass === "income"
  );
}

/** "#12", or "#12–#14" for a span. Empty when no line is known. */
export function lineWords(lineStart?: number, lineEnd?: number): string {
  if (lineStart === undefined) return "";
  if (lineEnd === undefined || lineEnd === lineStart) return `#${lineStart}`;
  return `#${lineStart}–#${lineEnd}`;
}

export const RESOLUTION_WORDS: Record<Resolution, string> = {
  resolved: "Resolved",
  unresolved: "Unresolved",
  unknown: "Unknown",
};

export const SCENARIO_WORDS: Record<IncomeScenario, string> = {
  current: "Current",
  target: "Target",
};

export const PERIOD_CHOICES: Record<IncomePeriod, string> = {
  month: "A month",
  year: "A year",
  week: "A week",
  hour: "An hour",
  per_session: "A session",
  one_off: "One time",
  point_in_time: "At a point in time",
  unknown: "Not said",
};

/** Currencies the grading writes accept. */
export const EVAL_CURRENCIES = [
  "USD",
  "CAD",
  "AUD",
  "EUR",
  "GBP",
  "HNL",
  "MXN",
] as const;

type LabelLike = {
  itemClass: string;
  category?: string;
  lineStart?: number;
  lineEnd?: number;
  resolution?: Resolution;
  scenario?: IncomeScenario;
  period?: IncomePeriod;
  currency?: string;
  minMinor?: number;
  maxMinor?: number;
};

/** "Price", "Business revenue", or the class word when an item has no category. */
export function labelCategoryWords(
  label: Pick<LabelLike, "itemClass" | "category">,
): string {
  if (isExtractionClass(label.itemClass) && label.category)
    return categoryLabel(label.itemClass, label.category);
  return itemClassWords(label.itemClass);
}

/** "Objection · Price · #12", the name a match select and a summary use. */
export function labelTitle(label: LabelLike): string {
  const parts = [itemClassWords(label.itemClass)];
  if (isExtractionClass(label.itemClass) && label.category)
    parts.push(categoryLabel(label.itemClass, label.category));
  const lines = lineWords(label.lineStart, label.lineEnd);
  if (lines) parts.push(lines);
  return parts.join(" · ");
}

/** The typed values of an extraction item in words: "Unresolved", "Current · 4,000 to 6,000 USD a month". */
export function labelValueWords(label: LabelLike): string[] {
  const parts: string[] = [];
  if (label.itemClass === "objection" && label.resolution)
    parts.push(RESOLUTION_WORDS[label.resolution]);
  if (label.itemClass === "income") {
    if (label.scenario) parts.push(SCENARIO_WORDS[label.scenario]);
    const money = moneyPhrase(label);
    if (money) parts.push(money);
    else if (label.period && label.period !== "unknown")
      parts.push(PERIOD_CHOICES[label.period]);
    if (money && !label.currency) parts.push("currency not stated");
  }
  return parts;
}

// ─── Suggested results ──────────────────────────────────────────────────────

/** The blind "How did the call end?" choices, in the order the select lists them. */
export const RESULT_CHOICES: ReadonlyArray<{
  value: SuggestionKind;
  label: string;
}> = [
  { value: "paid", label: "Paid" },
  { value: "promised", label: "Promised to pay" },
  { value: "call_back", label: "Call back" },
  { value: "lost", label: "Lost" },
  { value: "no_decision", label: "No decision" },
  { value: "no_show", label: "No-show" },
  { value: "empty_recording", label: "Empty recording" },
];

export const PAYMENT_TYPE_WORDS: Record<
  NonNullable<SuggestionValues["paymentType"]>,
  string
> = {
  pif: "Paid in full",
  split: "Split",
  monthly: "Monthly",
  deposit: "Deposit",
};

export const CONTACT_WORDS: Record<
  NonNullable<SuggestionValues["contactMethod"]>,
  string
> = {
  call: "Call",
  text: "Text",
};

export const NO_SHOW_REASON_WORDS: Record<NoShowReason, string> = {
  no_response: "No response",
  late_cancel: "Late cancel",
  technical_issues: "Technical issues",
  other: "Other",
};

/** Which result values the blind form asks for, by kind. */
export function resultValueFields(
  kind: SuggestionKind | undefined,
): Array<keyof SuggestionValues> {
  switch (kind) {
    case "paid":
    case "promised":
      return ["amountMinor", "currency", "currencyAssumed", "paymentType"];
    case "call_back":
      return ["callbackAt", "contactMethod"];
    case "lost":
      return ["lossCategory"];
    case "no_show":
      return ["noShowReason"];
    default:
      return [];
  }
}

/** Keeps only the values that apply to a kind, so a changed kind never carries stale values. */
export function valuesForKind(
  kind: SuggestionKind,
  values: SuggestionValues,
): SuggestionValues {
  const keep = new Set<string>(resultValueFields(kind));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values))
    if (keep.has(key) && value !== undefined) out[key] = value;
  if (!out.currency) delete out.currencyAssumed;
  return out as SuggestionValues;
}

/**
 * A result's values as labelled rows: amount, currency, payment type, call-back
 * time, contact, loss category, no-show reason. `when` formats a time.
 */
export function resultValueRows(
  values: SuggestionValues,
  when: (at: number) => string,
): Array<{ field: keyof SuggestionValues; label: string; value: string }> {
  const rows: Array<{
    field: keyof SuggestionValues;
    label: string;
    value: string;
  }> = [];
  if (values.amountMinor !== undefined)
    rows.push({
      field: "amountMinor",
      label: "Amount",
      value: formatMinorPlain(values.amountMinor),
    });
  if (values.currency)
    rows.push({
      field: "currency",
      label: "Currency",
      value:
        currencyWord(values.currency, values.currencyAssumed) ??
        values.currency,
    });
  if (values.paymentType)
    rows.push({
      field: "paymentType",
      label: "Payment type",
      value: PAYMENT_TYPE_WORDS[values.paymentType],
    });
  if (values.programId)
    rows.push({
      field: "programId",
      label: "Program",
      value: "A program of yours",
    });
  if (values.callbackAt !== undefined)
    rows.push({
      field: "callbackAt",
      label: "Call back",
      value: when(values.callbackAt),
    });
  if (values.contactMethod)
    rows.push({
      field: "contactMethod",
      label: "Contact by",
      value: CONTACT_WORDS[values.contactMethod],
    });
  if (values.lossCategory)
    rows.push({
      field: "lossCategory",
      label: "Loss category",
      value: LOSS_CATEGORIES[values.lossCategory],
    });
  if (values.noShowReason)
    rows.push({
      field: "noShowReason",
      label: "Reason",
      value: NO_SHOW_REASON_WORDS[values.noShowReason],
    });
  return rows;
}

// ─── Grading ────────────────────────────────────────────────────────────────

export type Verdict = "right" | "wrong" | "unsure";

export const VERDICT_CHOICES: ReadonlyArray<{ value: Verdict; label: string }> =
  [
    { value: "right", label: "Right" },
    { value: "wrong", label: "Wrong" },
    { value: "unsure", label: "Not sure" },
  ];

export function verdictWords(verdict?: string): string {
  return (
    VERDICT_CHOICES.find((choice) => choice.value === verdict)?.label ??
    "Not graded"
  );
}

/** One tick box under Wrong, and the exact field names it sends. */
export type WrongPart = { key: string; label: string; fields: string[] };

const IT_ISNT_THERE: WrongPart = {
  key: "exists",
  label: "It isn't there",
  fields: ["exists"],
};
const SPEAKER: WrongPart = {
  key: "speaker",
  label: "Speaker",
  fields: ["speaker"],
};

/**
 * The parts an admin can mark wrong on a graded item. Extraction items get
 * their class's parts; the suggested result gets its kind, tier and each value
 * it carries; the no-show tier gets attendance and tier.
 */
export function wrongPartOptions(label: {
  itemClass: string;
  resultValues?: SuggestionValues;
}): WrongPart[] {
  switch (label.itemClass) {
    case "objection":
      return [
        { key: "category", label: "Category", fields: ["category"] },
        { key: "resolution", label: "Resolution", fields: ["resolution"] },
        SPEAKER,
        IT_ISNT_THERE,
      ];
    case "struggle":
    case "goal":
      return [
        { key: "category", label: "Category", fields: ["category"] },
        SPEAKER,
        IT_ISNT_THERE,
      ];
    case "income":
      return [
        { key: "category", label: "Kind of income", fields: ["category"] },
        { key: "amount", label: "Amount", fields: ["minMinor", "maxMinor"] },
        { key: "currency", label: "Currency", fields: ["currency"] },
        { key: "period", label: "Period", fields: ["period"] },
        { key: "scenario", label: "Current or target", fields: ["scenario"] },
        SPEAKER,
        IT_ISNT_THERE,
      ];
    case "result": {
      const values = label.resultValues ?? {};
      const parts: WrongPart[] = [
        { key: "resultKind", label: "Result", fields: ["resultKind"] },
        { key: "resultTier", label: "How sure", fields: ["resultTier"] },
      ];
      if (values.amountMinor !== undefined)
        parts.push({
          key: "amountMinor",
          label: "Amount",
          fields: ["amountMinor"],
        });
      if (values.currency)
        parts.push({
          key: "currency",
          label: "Currency",
          fields: ["currency", "currencyAssumed"],
        });
      if (values.paymentType)
        parts.push({
          key: "paymentType",
          label: "Payment type",
          fields: ["paymentType"],
        });
      if (values.programId)
        parts.push({
          key: "programId",
          label: "Program",
          fields: ["programId"],
        });
      if (values.callbackAt !== undefined)
        parts.push({
          key: "callbackAt",
          label: "Call-back time",
          fields: ["callbackAt"],
        });
      if (values.contactMethod)
        parts.push({
          key: "contactMethod",
          label: "Contact",
          fields: ["contactMethod"],
        });
      if (values.lossCategory)
        parts.push({
          key: "lossCategory",
          label: "Loss category",
          fields: ["lossCategory"],
        });
      if (values.noShowReason)
        parts.push({
          key: "noShowReason",
          label: "No-show reason",
          fields: ["noShowReason"],
        });
      return parts;
    }
    case "attendance":
      return [
        { key: "attendance", label: "Attendance", fields: ["attendance"] },
        { key: "noShowTier", label: "No-show tier", fields: ["noShowTier"] },
      ];
    default:
      return [];
  }
}

/** The field names to send for the ticked parts, without duplicates. */
export function wrongFieldsFor(
  parts: readonly WrongPart[],
  ticked: ReadonlySet<string>,
): string[] {
  return [
    ...new Set(
      parts
        .filter((part) => ticked.has(part.key))
        .flatMap((part) => part.fields),
    ),
  ];
}

/** Which parts a stored wrong-fields list ticks. */
export function tickedParts(
  parts: readonly WrongPart[],
  wrongFields: readonly string[] | undefined,
): Set<string> {
  const stored = new Set(wrongFields ?? []);
  return new Set(
    parts
      .filter((part) => part.fields.some((field) => stored.has(field)))
      .map((part) => part.key),
  );
}

/** The ticked parts in words, "the whole item" when none is ticked. */
export function wrongPartsWords(
  parts: readonly WrongPart[],
  wrongFields: readonly string[] | undefined,
): string {
  const ticked = tickedParts(parts, wrongFields);
  const words = parts
    .filter((part) => ticked.has(part.key))
    .map((part) => part.label.toLowerCase());
  return words.length ? words.join(", ") : "the whole item";
}

/** How many of the reading's labels have a grade, and whether every one does. */
export function gradingProgress(
  labels: ReadonlyArray<{ adminVerdict?: string }>,
) {
  const graded = labels.filter(
    (label) => label.adminVerdict !== undefined,
  ).length;
  return { graded, total: labels.length, complete: graded === labels.length };
}

type MatchItem = {
  labelId: string;
  itemClass: string;
  category?: string;
  lineStart?: number;
  lineEnd?: number;
};

/**
 * The proposed match between the admin's own items and the reading's: same
 * class and category, spans within two lines of each other, nearest first,
 * each reading item used once. Mirrors `autoMatch` in
 * `convex/callInsights/eval/labels.ts`, which the grading screen can't import.
 */
export function proposeMatches<A extends MatchItem, E extends MatchItem>(
  adminItems: readonly A[],
  extractorItems: readonly E[],
): Array<{ labelId: A["labelId"]; matchedLabelId: E["labelId"] | null }> {
  const pairs = adminItems.flatMap((a, ai) =>
    extractorItems.flatMap((e, ei) =>
      a.itemClass === e.itemClass &&
      a.category === e.category &&
      a.lineStart !== undefined &&
      e.lineStart !== undefined &&
      a.lineStart <= (e.lineEnd ?? e.lineStart) + 2 &&
      e.lineStart <= (a.lineEnd ?? a.lineStart) + 2
        ? [{ ai, ei, distance: Math.abs(a.lineStart - e.lineStart) }]
        : [],
    ),
  );
  pairs.sort((a, b) => a.distance - b.distance || a.ai - b.ai || a.ei - b.ei);
  const matches = new Map<number, number>();
  const used = new Set<number>();
  for (const pair of pairs)
    if (!matches.has(pair.ai) && !used.has(pair.ei)) {
      matches.set(pair.ai, pair.ei);
      used.add(pair.ei);
    }
  return adminItems.map((a, index) => {
    const match = matches.get(index);
    return {
      labelId: a.labelId,
      matchedLabelId:
        match === undefined ? null : extractorItems[match].labelId,
    };
  });
}

/** Opus's verdict in words, as it appears beside an item once grades are saved. */
export function judgeWords(verdict?: string): string | null {
  if (verdict === "supported") return "supported";
  if (verdict === "contradicted") return "contradicted";
  if (verdict === "insufficient") return "not enough to tell";
  return null;
}

// ─── Form input ─────────────────────────────────────────────────────────────

/**
 * An amount typed by a person, in hundredths ("1,500.50" → 150050). Null when
 * empty; NaN when it isn't a non-negative amount with at most two decimals.
 */
export function parseAmountMinor(text: string): number | null {
  const cleaned = text.replace(/[,\s]/g, "");
  if (cleaned === "") return null;
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return Number.NaN;
  const minor = Math.round(Number.parseFloat(cleaned) * 100);
  return Number.isSafeInteger(minor) ? minor : Number.NaN;
}

/** A one-based line number typed into the form, checked against the transcript. Null when empty or out of range. */
export function parseLine(text: string, lineCount: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const line = Number.parseInt(text.trim(), 10);
  return line >= 1 && line <= lineCount ? line : null;
}

/**
 * Minutes after the scheduled start a prospect arrived. Negative for early,
 * decimals allowed. Null when empty or not a number.
 */
export function parseArrivalMinutes(text: string): number | null {
  const cleaned = text.trim();
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const minutes = Number.parseFloat(cleaned);
  return Number.isFinite(minutes) ? minutes : null;
}

/** Where a clicked transcript line goes: the start first, then the end, never an end before the start. */
export function pickLine(
  current: { lineStart: string; lineEnd: string; target: "start" | "end" },
  line: number,
): { lineStart: string; lineEnd: string; target: "start" | "end" } {
  const start = Number.parseInt(current.lineStart, 10);
  if (current.target === "start" || Number.isNaN(start)) {
    return { lineStart: String(line), lineEnd: String(line), target: "end" };
  }
  if (line < start)
    return { lineStart: String(line), lineEnd: String(start), target: "start" };
  return {
    lineStart: current.lineStart,
    lineEnd: String(line),
    target: "start",
  };
}

// ─── Bars ───────────────────────────────────────────────────────────────────

export type BarResult = "pass" | "fail" | "inconclusive";
export type ReportGroupKind = "quality" | "suggestions" | "no_show";

export const REPORT_GROUPS: ReadonlyArray<{
  kind: ReportGroupKind;
  label: string;
}> = [
  { kind: "quality", label: "What they said" },
  { kind: "suggestions", label: "Suggested results" },
  { kind: "no_show", label: "No-show" },
];

export function barResultWords(
  result: BarResult,
): "Passed" | "Failed" | "Not enough yet" {
  if (result === "pass") return "Passed";
  if (result === "fail") return "Failed";
  return "Not enough yet";
}

export function barResultTone(result: BarResult): "live" | "failed" | "owed" {
  if (result === "pass") return "live";
  if (result === "fail") return "failed";
  return "owed";
}

/**
 * What a bar still needs before it can be decided: "needs 6 more items",
 * "needs 4 more calls", "needs 6 more items and 4 more calls". Null once both
 * floors are reached.
 */
export function needsMoreWords(
  bar: { n: number; calls: number; floor: number },
  callFloor: number,
): string | null {
  const items = Math.max(0, bar.floor - bar.n);
  const calls = Math.max(0, callFloor - bar.calls);
  const parts = [
    items ? `${items} more ${items === 1 ? "item" : "items"}` : null,
    calls ? `${calls} more ${calls === 1 ? "call" : "calls"}` : null,
  ].filter(Boolean);
  return parts.length ? `needs ${parts.join(" and ")}` : null;
}

/** "at least 87% right (95% confidence)"; rounded down so it never overstates. */
export function lowerBoundWords(lowerBound: number | undefined): string | null {
  if (lowerBound === undefined || !Number.isFinite(lowerBound)) return null;
  return `at least ${Math.floor(lowerBound * 100)}% right (95% confidence)`;
}

/** "24 items · 12 calls". */
export function countedWords(bar: { n: number; calls: number }): string {
  return `${bar.n} ${bar.n === 1 ? "item" : "items"} · ${bar.calls} ${bar.calls === 1 ? "call" : "calls"}`;
}

export const CAPABILITY_WORDS: Record<string, string> = {
  whatTheySaid: "What they said, for closers",
  suggestions: "Suggested results on meetings",
  amountPrefill: "Amount prefill",
  noShowCertain: "Certain no-shows",
};

export function capabilityWords(key: string): string {
  return CAPABILITY_WORDS[key] ?? key;
}

// ─── Opus ───────────────────────────────────────────────────────────────────

export const JUDGE_DIMENSION_WORDS: Record<string, string> = {
  objection: "Objections",
  struggle: "Struggles",
  goal: "Goals",
  income: "Income",
  result: "Suggested results",
  attendance: "No-shows",
};

export function trustWords(trust: string): "May stop a change" | "Advisory" {
  return trust === "may_block" ? "May stop a change" : "Advisory";
}

/** "27 of 30 (90%)", or a dash with nothing compared. */
export function shareWords(part: number, whole: number): string {
  if (whole === 0) return "—";
  return `${part} of ${whole} (${Math.round((part / whole) * 100)}%)`;
}

export const REGRESSION_MODELS = [
  { value: "anthropic/claude-sonnet-5.5", label: "Sonnet 5.5" },
  { value: "anthropic/claude-opus-5.5", label: "Opus 5.5" },
] as const;

// ─── No-show wait ───────────────────────────────────────────────────────────

/** "4.9%", one decimal, rounded up so a bound never reads better than it is. */
export function upperBoundWords(upperBound: number): string {
  return `${(Math.ceil(upperBound * 1000) / 10).toFixed(1)}%`;
}

/** "12% of recordings started after the scheduled time." */
export function lateStartWords(share: number): string {
  return `${Math.round(share * 100)}% of recordings started after the scheduled time.`;
}
