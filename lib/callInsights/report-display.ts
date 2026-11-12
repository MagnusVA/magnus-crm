import type {
  RunReason,
  RunStatus,
} from "../../convex/callInsights/validators";
import { NOT_READ_REASONS, TIER_BADGES } from "./display";
import {
  INCOME_BAND_EDGES,
  SUGGESTION_KIND_LABELS,
  type IncomeKind,
  type NoShowTier,
  type SuggestionKind,
  type SuggestionTier,
} from "./taxonomy";

/**
 * Words for the Call insights page, its settings and the person page section.
 * Reasons, tiers and income lines come from the meeting card's helpers in
 * `display.ts`, so every surface says them the same way. Pure: no React, no
 * Convex, so the tests cover every label.
 */

// ─── Numbers ─────────────────────────────────────────────────────────────────

const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** "41%" of the whole, or "—" when there is nothing to divide by. */
export function percentOf(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0)
    return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

/** A model spend in USD: "$3.10". */
export function formatUsd(amount: number): string {
  return USD.format(Number.isFinite(amount) ? amount : 0);
}

/** "1 call", "3 calls". */
export function callCount(count: number): string {
  return `${WHOLE.format(count)} ${count === 1 ? "call" : "calls"}`;
}

// ─── Run status ──────────────────────────────────────────────────────────────

export type CallStatusWord = "Read" | "Reading" | "Waiting" | "Not read";

/** The one status word a call's row shows. */
export function callStatusWord(status: RunStatus): CallStatusWord {
  switch (status) {
    case "answered":
      return "Read";
    case "waiting":
      return "Waiting";
    case "failed":
    case "skipped":
      return "Not read";
    default:
      return "Reading";
  }
}

/** The status word's tone: ink when read, amber while waiting, red when it failed, slate otherwise. */
export function callStatusTone(
  status: RunStatus,
): "live" | "owed" | "failed" | "done" {
  if (status === "answered") return "live";
  if (status === "waiting") return "owed";
  if (status === "failed") return "failed";
  return "done";
}

/**
 * Why a call wasn't read, as the meeting card says it, without the closing
 * period so it can sit in a row. Codes this build doesn't know (and the
 * report's "unknown") read "No reason was recorded".
 */
export function reasonWords(reason: string | undefined): string {
  const words =
    reason && Object.prototype.hasOwnProperty.call(NOT_READ_REASONS, reason)
      ? NOT_READ_REASONS[reason as RunReason]
      : undefined;
  return (words ?? "No reason was recorded.").replace(/\.$/, "");
}

/** The Calls tab's status filter: one stored status each. */
export const CALL_STATUS_FILTERS: ReadonlyArray<{
  value: "all" | RunStatus;
  label: string;
}> = [
  { value: "all", label: "All calls" },
  { value: "answered", label: "Read" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Reading" },
  { value: "checking", label: "Being checked" },
  { value: "waiting", label: "Waiting" },
  { value: "failed", label: "Not read: failed" },
  { value: "skipped", label: "Not read: skipped" },
];

// ─── Suggestions ─────────────────────────────────────────────────────────────

export function suggestionKindWords(kind: SuggestionKind): string {
  return SUGGESTION_KIND_LABELS[kind] ?? kind;
}

export function suggestionTierWords(tier: SuggestionTier): string {
  return TIER_BADGES[tier] ?? tier;
}

const NO_SHOW_TIER_WORDS: Record<NoShowTier, string> = {
  none: "Not a no-show",
  empty: "Empty recording",
  check: "Check",
  certain: "Clear no-show",
  review: "Review",
  unconfirmed: "Not confirmed",
};

export function noShowTierWords(tier: string): string {
  return (NO_SHOW_TIER_WORDS as Record<string, string>)[tier] ?? tier;
}

/** Order of the no-show tiers in the report. */
export const NO_SHOW_TIER_ORDER: readonly NoShowTier[] = [
  "certain",
  "review",
  "check",
  "empty",
  "unconfirmed",
  "none",
];

const RECORDED_WORDS: Record<string, string> = {
  paid: "Paid",
  call_back: "Call back",
  lost: "Lost",
  no_show: "No-show",
  held_other: "Held, other result",
  canceled: "Canceled",
};

/** What a person saved on the meeting, from `recordedKind`. */
export function recordedKindWords(kind: string): string {
  return RECORDED_WORDS[kind] ?? "Other result";
}

export function comparisonWords(
  comparison:
    | "same_result"
    | "different_result"
    | "same_result_different_values",
): string {
  if (comparison === "same_result_different_values")
    return "Same result, different amount";
  if (comparison === "different_result") return "Different result";
  return "Same result";
}

/** The four groups of the agreement split, in the order the table shows them. */
export const AGREEMENT_GROUPS = [
  { key: "noneShown", label: "No suggestion shown" },
  { key: "shownNotUsed", label: "Shown but not used" },
  { key: "used", label: "Used" },
  { key: "usedEdited", label: "Used and edited" },
] as const;

// ─── Capability checks ───────────────────────────────────────────────────────

export type CheckResult = "pass" | "fail" | "inconclusive";

/** The quality checks behind a switch, as its badge says them. */
export function checkResultWords(result: CheckResult): string {
  if (result === "pass") return "Checks passed";
  if (result === "fail") return "Checks failing";
  return "Not enough graded calls yet";
}

/** The one sentence a switch's confirm adds when its checks haven't passed. */
export function checkWarning(result: CheckResult | undefined): string | null {
  if (result === "pass") return null;
  if (result === "fail")
    return "Its quality checks are failing, so expect mistakes.";
  return "Not enough calls have been graded yet to know how often it is right.";
}

// ─── Income ──────────────────────────────────────────────────────────────────

const SPECIAL_BANDS: Record<string, string> = {
  spans_bands: "Spans bands",
  currency_not_stated: "Currency not stated",
  other_currency: "Other currency",
  no_monthly_equivalent: "No monthly equivalent",
  speaker_unclear: "Speaker unclear",
};

function shortUsd(major: number) {
  if (major >= 1000) return `$${WHOLE.format(major / 1000)}k`;
  return `$${WHOLE.format(major)}`;
}

/**
 * A monthly USD band key from the income reader as words: "b1000" for
 * personal income is "$1k–3k", the top band "$20k+", the special keys their names.
 */
export function incomeBandWords(kind: string, band: string): string {
  if (band in SPECIAL_BANDS) return SPECIAL_BANDS[band];
  const edges = INCOME_BAND_EDGES[kind as IncomeKind];
  const lower = /^b(\d+)$/.exec(band)?.[1];
  if (!edges || lower === undefined) return band;
  const edge = Number(lower);
  const index = edges.indexOf(edge);
  if (index === -1) return band;
  const next = edges[index + 1];
  if (next === undefined) return `${shortUsd(edge)}+`;
  if (edge === 0 && next === 1) return "Nothing";
  if (edge <= 1) return `Under ${shortUsd(next)}`;
  return `${shortUsd(edge)}–${shortUsd(next).slice(1)}`;
}

/** Sort weight for a band: money bands low to high, then the special rows. */
export function incomeBandOrder(band: string): number {
  const lower = /^b(\d+)$/.exec(band)?.[1];
  if (lower !== undefined) return Number(lower);
  const special = Object.keys(SPECIAL_BANDS).indexOf(band);
  return Number.MAX_SAFE_INTEGER - 10 + (special === -1 ? 9 : special);
}
