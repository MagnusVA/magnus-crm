export const MAX_PROVIDER_PAYMENT_AGE_MS = 7 * 86_400_000;

export function isWhopSweepFresh(lastSuccessfulSweepAt: number | null, now: number) {
  return lastSuccessfulSweepAt !== null && now - lastSuccessfulSweepAt <= 15 * 60_000;
}
