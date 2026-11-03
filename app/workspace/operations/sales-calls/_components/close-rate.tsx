import { closeRateOfRow, type SalesCloseRate } from "./sales-calls-data";

export const CLOSE_RATE_HELP =
  "Of the deals whose first held call in the range was with this closer, the share won so far. Open deals can still close, so a recent range's rate rises over time.";

export const TEAM_CLOSE_RATE_HELP =
  "Of the deals whose first held call was in the range, the share won so far. Each deal counts once, at its first held call. Open deals can still close, so a recent range's rate rises over time.";

export const PROGRAM_CLOSE_RATE_HELP =
  "Of the deals whose first held call in the range was booked for this program, the share won so far. Open deals can still close, so a recent range's rate rises over time.";

const percentFormatter = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

/** The close rate, or "—" when it has no deals or the answer predates it. */
export function formatCloseRate(row: SalesCloseRate) {
  const closeRate = closeRateOfRow(row)?.closeRate ?? null;
  return closeRate === null ? "—" : percentFormatter.format(closeRate);
}

/**
 * "N of M deals won" for a close rate; null when the counts are unknown, or
 * (with `hideWhenEmpty`) when no deal counts.
 */
export function dealsWonWords(row: SalesCloseRate, hideWhenEmpty = false) {
  const counts = closeRateOfRow(row);
  if (!counts || (hideWhenEmpty && counts.cohortDeals === 0)) return null;
  if (counts.cohortDeals === 0) return "No deals had a first held call";
  return `${counts.wonDeals.toLocaleString()} of ${counts.cohortDeals.toLocaleString()} deal${counts.cohortDeals === 1 ? "" : "s"} won`;
}
