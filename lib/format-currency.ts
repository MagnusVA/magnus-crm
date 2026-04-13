/**
 * Shared currency formatting utilities.
 *
 * Two variants:
 * - `formatAmountMinor()` — accepts integer cents (minor units), divides by 100 before formatting.
 * - `formatCurrency()` — accepts a dollar (major-unit) value directly.
 *
 * Both use `Intl.NumberFormat` for locale-aware currency symbols, thousands
 * separators, and decimal precision.
 */

/**
 * Format a minor-unit amount (integer cents) as a locale-formatted currency string.
 *
 * @example formatAmountMinor(29999, "USD") => "$299.99"
 * @example formatAmountMinor(0, "EUR") => "€0.00"
 */
export function formatAmountMinor(
  amountMinor: number,
  currency: string,
): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amountMinor / 100);
}

/**
 * Format a major-unit amount (dollars) as a locale-formatted currency string.
 *
 * Use this when the backend query already returns a dollar-denominated value
 * (e.g. `totalPaid`, `revenueLogged`, or payments with `amount = amountMinor / 100`).
 *
 * @example formatCurrency(299.99, "USD") => "$299.99"
 * @example formatCurrency(0, "EUR") => "€0.00"
 */
export function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount);
}
