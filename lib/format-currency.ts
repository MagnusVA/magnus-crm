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

const FALLBACK_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

function fallbackAmount(amount: number, currency: string) {
  const label = currency.trim().toUpperCase() || "UNKNOWN";
  return `${FALLBACK_FORMAT.format(amount)} ${label}`;
}

const currencyFormats = new Map<string, Intl.NumberFormat>();

/**
 * One cached formatter per currency and notation. An unknown currency code
 * throws a RangeError here, as `new Intl.NumberFormat` does, and isn't cached.
 */
function currencyFormat(currency: string, compact = false) {
  const code = currency.toUpperCase();
  const key = `${compact ? "compact" : "standard"}:${code}`;
  let formatter = currencyFormats.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(
      "en-US",
      compact
        ? { style: "currency", currency: code, notation: "compact", maximumFractionDigits: 1 }
        : { style: "currency", currency: code },
    );
    currencyFormats.set(key, formatter);
  }
  return formatter;
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
    return currencyFormat(currency).format(amount);
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
    return currencyFormat(currency, true).format(amount);
  } catch {
    return fallbackAmount(amount, currency);
  }
}

/** Number of decimal places Intl uses when presenting a currency. */
export function getCurrencyFractionDigits(currency: string): number {
  try {
    return currencyFormat(currency).resolvedOptions().maximumFractionDigits ?? 2;
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
    return currencyFormat(currency).format(amount);
  } catch {
    return fallbackAmount(amount, currency);
  }
}
