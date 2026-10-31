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

/** "N of M deals won" under a close rate; nothing when the counts are unknown. */
export function DealsWon({
  row,
  hideWhenEmpty = false,
}: {
  row: SalesCloseRate;
  hideWhenEmpty?: boolean;
}) {
  const counts = closeRateOfRow(row);
  if (!counts || (hideWhenEmpty && counts.cohortDeals === 0)) return null;
  return (
    <p className="mt-1 text-xs font-normal text-muted-foreground">
      {counts.wonDeals.toLocaleString()} of{" "}
      {counts.cohortDeals.toLocaleString()} deal
      {counts.cohortDeals === 1 ? "" : "s"} won
    </p>
  );
}
