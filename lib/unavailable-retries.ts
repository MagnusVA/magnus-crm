/**
 * The retry count of `app/unavailable`, kept in session storage as
 * `{ count, at }`.
 */

/** Seconds the page waits before each automatic try. After the last, it waits to be asked. */
export const RETRY_DELAYS_SECONDS = [10, 30, 60, 120, 300];

/** A count this old is from an earlier outage, so the page starts over. */
const STALE_AFTER_MS = 15 * 60_000;

export function storedAttempts(count: number, now: number): string {
  return JSON.stringify({ count, at: now });
}

/** Tries made so far in this outage. Anything unreadable or stale counts as none. */
export function attemptsFromStored(stored: string | null, now: number): number {
  if (!stored) return 0;
  try {
    const { count, at } = JSON.parse(stored) as { count?: unknown; at?: unknown };
    if (
      typeof count !== "number" ||
      typeof at !== "number" ||
      !Number.isInteger(count) ||
      count < 0 ||
      now - at > STALE_AFTER_MS
    ) {
      return 0;
    }
    return Math.min(count, RETRY_DELAYS_SECONDS.length);
  } catch {
    return 0;
  }
}
