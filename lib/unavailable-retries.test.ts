import { describe, expect, it } from "vitest";
import { RETRY_DELAYS_SECONDS, attemptsFromStored, storedAttempts } from "./unavailable-retries";

const NOW = Date.UTC(2026, 9, 31, 19, 25, 0);

describe("the unavailable page's retry count", () => {
  it("starts at none, so the first wait is the shortest", () => {
    expect(attemptsFromStored(null, NOW)).toBe(0);
    expect(RETRY_DELAYS_SECONDS[0]).toBe(10);
  });

  it("carries the count across the page load each try makes", () => {
    expect(attemptsFromStored(storedAttempts(3, NOW - 120_000), NOW)).toBe(3);
  });

  it("stops at the number of waits, where the page offers the button only", () => {
    const exhausted = attemptsFromStored(storedAttempts(9, NOW), NOW);
    expect(exhausted).toBe(RETRY_DELAYS_SECONDS.length);
    expect(RETRY_DELAYS_SECONDS[exhausted]).toBeUndefined();
  });

  it("starts over for a later outage", () => {
    expect(attemptsFromStored(storedAttempts(5, NOW - 16 * 60_000), NOW)).toBe(0);
  });

  it("starts over when the stored value is not a count", () => {
    for (const stored of ["", "5", "not json", '{"count":"2","at":1}', '{"count":-1,"at":1}', '{"count":1.5,"at":1}']) {
      expect(attemptsFromStored(stored, NOW), stored).toBe(0);
    }
  });
});
