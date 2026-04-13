export function validateAmountMinor(amountMinor: number): number {
  if (!Number.isFinite(amountMinor) || amountMinor < 0) {
    throw new Error("Amount must be a non-negative finite number");
  }

  const rounded = Math.round(amountMinor);
  if (rounded !== amountMinor) {
    throw new Error("Amount in minor units must be an integer");
  }

  return rounded;
}

export function toAmountMinor(displayAmount: number): number {
  if (!Number.isFinite(displayAmount) || displayAmount <= 0) {
    throw new Error("Amount must be a positive finite number");
  }

  return validateAmountMinor(Math.round(displayAmount * 100));
}

export function validateCurrency(currency: string): string {
  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error("Currency must be a 3-letter uppercase code");
  }

  return normalized;
}
