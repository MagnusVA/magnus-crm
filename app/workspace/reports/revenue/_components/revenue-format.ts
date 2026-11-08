import { formatCash } from "@/lib/closer-pipeline";

/**
 * The revenue readers sum amounts without splitting them by currency, so the
 * page reads them in dollars, as it always has. Single payments (Top deals)
 * keep their own currency.
 */
export const REVENUE_CURRENCY = "USD";

/** A whole-dollar amount: "$147,350". */
export function dollars(amountMinor: number) {
  return formatCash(Math.round(amountMinor / 100) * 100, REVENUE_CURRENCY);
}

/** A part of a whole as "34.2%", or "—" with no whole. */
export function shareOf(part: number, whole: number) {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—";
}

export function formatCount(count: number) {
  return count.toLocaleString("en-US");
}

export function countWords(count: number, one: string, many = `${one}s`) {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}
