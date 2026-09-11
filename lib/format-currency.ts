/**
 * Shared currency formatting utilities.
 *
 * Two variants:
 * - `formatAmountMinor()` — accepts the app's integer hundredths, divides by 100 before formatting.
 * - `formatCurrency()` — accepts a major-unit value directly.
 *
 * Both use `Intl.NumberFormat` for locale-aware currency symbols, thousands
 * separators, and decimal precision.
 */

function fallbackAmount(amount: number, currency: string) {
  const label = currency.trim().toUpperCase() || "UNKNOWN";
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(amount)} ${label}`;
}

/**
 * Format an amount stored by Magnus as integer hundredths.
 *
 * `paymentRecords.amountMinor` is produced from user-entered decimal amounts by
 * multiplying by 100 for every currency. It is not a Stripe/ISO-4217 minor-unit
 * value, so zero-decimal and three-decimal currency exponents must not change
 * the divisor here. Intl still controls the displayed fraction digits.
 *
 * @example formatAmountMinor(29999, "USD") => "$299.99"
 * @example formatAmountMinor(0, "EUR") => "€0.00"
 */
export function formatAmountMinor(
  amountMinor: number,
  currency: string,
): string {
  const amount = amountMinor / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount);
  } catch {
    return fallbackAmount(amount, currency);
  }
}

/** Format the app's integer-hundredths amount with compact notation. */
export function formatCompactAmountMinor(
  amountMinor: number,
  currency: string,
): string {
  const amount = amountMinor / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(amount);
  } catch {
    return fallbackAmount(amount, currency);
  }
}

/** Number of decimal places Intl uses when presenting a currency. */
export function getCurrencyFractionDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Format a major-unit amount as a locale-formatted currency string.
 *
 * Use this when the backend query already returns a major-unit value
 * (e.g. `totalPaid`, `revenueLogged`, or payments with `amount = amountMinor / 100`).
 *
 * @example formatCurrency(299.99, "USD") => "$299.99"
 * @example formatCurrency(0, "EUR") => "€0.00"
 */
export function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount);
  } catch {
    return fallbackAmount(amount, currency);
  }
}
