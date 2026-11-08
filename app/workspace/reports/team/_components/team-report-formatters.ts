import { formatCash } from "@/lib/closer-pipeline";

// Words and figures the Team Performance cards share. Team money is one sum
// in minor units, shown in US dollars as the report always has.

const wholeNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

export function formatCount(value: number): string {
  return wholeNumber.format(value);
}

/** A rate at one decimal, or "—" when it has no base. */
export function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatMoney(minorUnits: number): string {
  return formatCash(Math.round(minorUnits), "USD");
}

/** "7 of 12 past calls have a result", "(partial)" when the counts are a lower bound. */
export function resultsWords(
  counts: { resultsRecorded: number; pastCalls: number },
  partial: boolean | undefined,
): string {
  if (counts.pastCalls === 0 && !partial) return "No past calls yet";
  return `${formatCount(counts.resultsRecorded)} of ${formatCount(counts.pastCalls)} past calls have a result${partial ? " (partial)" : ""}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

export const CLOSER_CLOSE_RATE_HELP =
  "Of the deals whose first held call in the range was with this closer, the share won so far. Open deals can still close, so a recent range's rate rises over time.";

export const TEAM_CLOSE_RATE_HELP =
  "Of the deals whose first held call was in the range, the share won so far. Open deals can still close, so a recent range's rate rises over time.";

/**
 * The cohort close rate and its counts, or nulls when they're unknown: the
 * cohort read was capped, or the answer was cached before the report had
 * cohort counts (its `closeRate` then is the old payment rate, so it's left
 * out too).
 */
export function cohortCloseRate(row: {
  closeRate?: number | null;
  cohortDeals?: number | null;
  wonDeals?: number | null;
}): { rate: number | null; wonDeals: number | null; cohortDeals: number | null } {
  if (typeof row.cohortDeals !== "number" || typeof row.wonDeals !== "number") {
    return { rate: null, wonDeals: null, cohortDeals: null };
  }
  return {
    rate: row.closeRate ?? null,
    wonDeals: row.wonDeals,
    cohortDeals: row.cohortDeals,
  };
}

/** "3 of 8 deals won", "No deals had a first held call", or null when unknown. */
export function dealsWonWords(counts: { wonDeals: number | null; cohortDeals: number | null }): string | null {
  if (counts.wonDeals === null || counts.cohortDeals === null) return null;
  if (counts.cohortDeals === 0) return "No deals had a first held call";
  return `${formatCount(counts.wonDeals)} of ${plural(counts.cohortDeals, "deal")} won`;
}
