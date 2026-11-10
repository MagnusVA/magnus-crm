import { addBusinessDays } from "../../businessDay";
import type { ResolvedAnalyticsRange } from "../../analyticsRange";
import type { BusinessDaySetting } from "../../businessDay";
import { formatAmountMinor } from "../../format-currency";

// Money and number words shared by the Scorecard and Attribution pages
// (reports-decisions D8): every amount keeps its currency, a page shows one
// currency at a time, and amounts in two currencies are never added.

const wholeNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const share = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

export function formatCount(value: number) {
  return wholeNumber.format(value);
}

/** An amount in the app's hundredths, in its own currency. */
export function formatMoney(amountMinor: number, currency: string) {
  return formatAmountMinor(amountMinor, currency);
}

/** A share, or "—" when it has no base (The Worded Zero Rule). */
export function formatShare(numerator: number, denominator: number) {
  return denominator > 0 ? share.format(numerator / denominator) : "—";
}

/** A ratio that may have no base, such as a coverage the server left null. */
export function formatRatio(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : share.format(value);
}

/** Every currency named in the lists, once, in alphabetical order. */
export function listCurrencies(...lists: ReadonlyArray<ReadonlyArray<{ currency: string }> | undefined>): string[] {
  const currencies = new Set<string>();
  for (const list of lists) for (const row of list ?? []) currencies.add(row.currency);
  return [...currencies].sort((a, b) => a.localeCompare(b));
}

/**
 * The currency a page opens on: the one with the most payments, ties to US
 * dollars, then alphabetical (the Sales calls rule). Null with no currency.
 */
export function pickMainCurrency(entries: ReadonlyArray<{ currency: string; weight: number }>): string | null {
  if (entries.length === 0) return null;
  return [...entries].sort(
    (a, b) =>
      b.weight - a.weight ||
      Number(b.currency === "USD") - Number(a.currency === "USD") ||
      a.currency.localeCompare(b.currency),
  )[0].currency;
}

/** The chosen currency when it still appears, else the main one. */
export function shownCurrency(requested: string | null, currencies: readonly string[], main: string | null) {
  return requested !== null && currencies.includes(requested) ? requested : (main ?? currencies[0] ?? "USD");
}

/** The row for one currency in a per-currency list, if any. */
export function inCurrency<Row extends { currency: string }>(rows: readonly Row[] | undefined, currency: string): Row | undefined {
  return rows?.find((row) => row.currency === currency);
}

/**
 * The resolved range the Scorecard readers take, from the picker's day keys
 * and window: the readers check it against the tenant's own day definition.
 */
export function resolvedReportRange(
  keys: { startDayKey: string; endDayKeyExclusive: string },
  window: { startDate: number; endDate: number },
  setting: BusinessDaySetting,
): ResolvedAnalyticsRange {
  return {
    startDate: keys.startDayKey,
    endDateInclusive: addBusinessDays(keys.endDayKeyExclusive, -1),
    fromMs: window.startDate,
    toMs: window.endDate,
    timeZone: setting.timeZone,
    dayStartHour: setting.dayStartHour,
  };
}
