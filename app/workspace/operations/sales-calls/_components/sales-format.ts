import { ATTENDANCE_COUNTS_PARTIAL_HELP } from "@/app/workspace/_components/results-recorded";

const wholeNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });

export function formatCount(value: number) {
  return wholeNumber.format(value);
}

/** A rate, or "—" when it has no base (nothing held or missed). */
export function formatRateOrDash(value: number | null) {
  return value === null || !Number.isFinite(value) ? "—" : percent.format(value);
}

/** "7 of 12 past calls have a result", "(partial)" when the counts are a lower bound. */
export function resultsWords(
  counts: { resultsRecorded: number; pastCalls: number },
  partial: boolean | undefined,
) {
  if (counts.pastCalls === 0 && !partial) return "No past calls yet";
  return `${formatCount(counts.resultsRecorded)} of ${formatCount(counts.pastCalls)} past calls have a result${partial ? " (partial)" : ""}`;
}

/** The partial count's reason, for the results line's title. */
export function resultsTitle(partial: boolean | undefined) {
  return partial ? ATTENDANCE_COUNTS_PARTIAL_HELP : undefined;
}

// Figures in Barlow Condensed with tabular numerals (DESIGN.md, The Condensed Figures Rule).
export const FIGURE_15 = "font-condensed text-[15px] font-semibold tabular-nums";
export const COLUMN_HEAD =
  "min-h-7 px-2.5 py-1 align-bottom font-condensed text-[11px] leading-tight font-semibold tracking-[0.14em] text-muted-foreground uppercase";
