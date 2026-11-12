import { describe, expect, it } from "vitest";
import { lowerBound, upperBound, minNForZeroErrors } from "./stats";

describe("exact one-sided 95% binomial bounds", () => {
  it.each([
    [0.05, 59],
    [0.03, 99],
    [0.02, 149],
  ])("zero errors at tolerance %s needs %s", (t, n) => {
    expect(minNForZeroErrors(t)).toBe(n);
    expect(upperBound(0, n)).toBeLessThanOrEqual(t);
    expect(upperBound(0, n - 1)).toBeGreaterThan(t);
  });
  it.each([
    [29, 29, 0.901855],
    [57, 60, 0.875805],
    [1, 1, 0.05],
    [9, 10, 0.605837],
    [10, 10, 0.741134],
    [0, 100, 0],
  ])("lower bound %s/%s", (k, n, p) =>
    expect(lowerBound(k, n)).toBeCloseTo(p, 4),
  );
  it("has complementary tails and conservative empty samples", () => {
    expect(upperBound(0, 100)).toBeCloseTo(0.029513, 5);
    expect(upperBound(100, 100)).toBe(1);
    expect(upperBound(0, 0)).toBe(1);
    expect(lowerBound(0, 0)).toBe(0);
    for (const n of [1, 20, 60, 100])
      for (let k = 0; k <= n; k++)
        expect(upperBound(k, n)).toBeCloseTo(1 - lowerBound(n - k, n), 12);
  });
  it.each([
    [-1, 10],
    [11, 10],
    [1.5, 10],
    [0, -1],
    [0, NaN],
  ])("rejects invalid counts %s/%s", (k, n) =>
    expect(() => lowerBound(k, n)).toThrow(),
  );
  it.each([0, 1, -0.1, Infinity, NaN])("rejects invalid tolerance %s", (t) =>
    expect(() => minNForZeroErrors(t)).toThrow(),
  );
});
