export function formatRate(rate: number | null): string {
  if (rate === null) return "\u2014";
  return `${(rate * 100).toFixed(1)}%`;
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
