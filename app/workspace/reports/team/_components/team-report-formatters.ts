export function formatRate(rate: number | null): string {
  if (rate === null) return "\u2014";
  return `${(rate * 100).toFixed(1)}%`;
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

export function formatCohortCounts(counts: {
  wonDeals: number | null;
  cohortDeals: number | null;
}): string | null {
  if (counts.wonDeals === null || counts.cohortDeals === null) return null;
  return `${counts.wonDeals} won of ${counts.cohortDeals} ${counts.cohortDeals === 1 ? "deal" : "deals"}`;
}

export function formatCurrency(minorUnits: number): string {
  return `$${(minorUnits / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatCompactCurrency(minorUnits: number): string {
  return `$${(minorUnits / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "\u2014";

  const totalMinutes = Math.round(durationMs / 60000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}
