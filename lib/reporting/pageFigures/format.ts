import { formatAmountMinor } from "../../format-currency";

// Words and numbers shared by Calls, People and the member report. Rates read
// a dash with no base (DESIGN.md, The Worded Zero Rule); money is always one
// currency at a time (The Separate Currencies Rule).

const COUNT = new Intl.NumberFormat("en-US");

export function formatCount(value: number) {
  return COUNT.format(value);
}

/** A share, or null when there is nothing to divide by. */
export function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** "73.1%", or "—" with no base. */
export function formatRate(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

/** "1 call", "3 calls". */
export function plural(count: number, one: string, many = `${one}s`) {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** "2 of 3", or the reason there is no base. */
export function ofWords(numerator: number, denominator: number, none: string) {
  return denominator > 0 ? `${formatCount(numerator)} of ${formatCount(denominator)}` : none;
}

/** The middle value, or null for none. Even counts average the middle two. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Minutes as "22 min", "3.5 h" or "2.1 days"; "—" for none. */
export function formatMinutes(value: number | null) {
  if (value === null) return "—";
  const minutes = Math.max(0, value);
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / 1440).toFixed(1)} days`;
}

export function formatMoney(amountMinor: number, currency: string) {
  return formatAmountMinor(amountMinor, currency);
}

/** A count per scheduled hour: "1.69/h", or null with no schedule. */
export function perHour(count: number, hours: number) {
  return hours > 0 ? `${(count / hours).toFixed(2)}/h` : null;
}

/** "Created opportunity" from "created_opportunity". */
export function humanize(value: string) {
  const words = value.replace(/[_-]+/gu, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : value;
}

type Money = { currency: string };

/**
 * The currencies money appears in, the main one first: the one held by the
 * most rows (a payment count per currency isn't in these reports, so rows
 * stand in for it), then US dollars, then alphabetical. Never by amount.
 */
export function rankCurrencies(groups: ReadonlyArray<ReadonlyArray<Money>>): string[] {
  const rows = new Map<string, number>();
  for (const group of groups) {
    for (const currency of new Set(group.map((money) => money.currency.toUpperCase()))) {
      rows.set(currency, (rows.get(currency) ?? 0) + 1);
    }
  }
  return [...rows]
    .sort(
      ([a, aRows], [b, bRows]) =>
        bRows - aRows || Number(b === "USD") - Number(a === "USD") || a.localeCompare(b),
    )
    .map(([currency]) => currency);
}

/** The chosen currency while it still appears, else the main one, else USD. */
export function pickCurrency(currencies: readonly string[], requested: string | null) {
  return requested && currencies.includes(requested) ? requested : (currencies[0] ?? "USD");
}

/** The range part of the URL, kept on links between report pages. */
export function rangeQuery(params: { get(name: string): string | null }) {
  const kept = new URLSearchParams();
  for (const key of ["range", "from", "to"]) {
    const value = params.get(key);
    if (value) kept.set(key, value);
  }
  const query = kept.toString();
  return query ? `?${query}` : "";
}

/** "Nov 5 · 3:00 PM" in the viewer's clock. */
export function formatWhen(at: number) {
  const date = new Date(at);
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} · ${date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

/** "Nov 5" from a business date key "2026-11-05". */
export function dayLabel(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
