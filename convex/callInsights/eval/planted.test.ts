import { describe, expect, it } from "vitest";
import { plantDefects } from "./planted";
import type { Candidate } from "./judgePrompt";
const candidates: Candidate[] = [
  {
    key: "income:0",
    itemClass: "income",
    category: "personal_income",
    scenario: "current",
    minMinor: 600000,
    maxMinor: 800000,
    currency: "USD",
    period: "month",
    lineStart: 2,
    numberlessProspectLines: [3],
  },
  {
    key: "objection:0",
    itemClass: "objection",
    category: "price",
    resolution: "unresolved",
    lineStart: 4,
  },
  {
    key: "result",
    itemClass: "result",
    resultKind: "promised",
    resultValues: { amountMinor: 170000, currency: "USD" },
  },
];
describe("planted defects", () => {
  it("is deterministic, caps at two, and preserves the originals", () => {
    const before = JSON.stringify(candidates);
    expect(plantDefects("case-a", candidates)).toEqual(
      plantDefects("case-a", candidates),
    );
    expect(plantDefects("case-a", candidates)).toHaveLength(2);
    expect(JSON.stringify(candidates)).toBe(before);
    expect(plantDefects("case-a", [])).toEqual([]);
  });
  it("generates every applicable defect and keeps its source key", () => {
    const plants = Array.from({ length: 100 }, (_, i) =>
      plantDefects(`case-${i}`, candidates),
    ).flat();
    expect(new Set(plants.map((p) => p.plantedDefect))).toEqual(
      new Set([
        "invented_income",
        "swapped_amount",
        "wrong_currency",
        "promise_as_paid",
        "wrong_category",
        "unsupported_resolution",
      ]),
    );
    for (const p of plants) {
      expect(p.key).toContain(p.originalKey);
      switch (p.plantedDefect) {
        case "invented_income":
          expect(p.lineStart).toBe(3);
          break;
        case "swapped_amount":
          expect([p.minMinor, p.maxMinor]).toEqual([6000000, 8000000]);
          break;
        case "wrong_currency":
          expect(p.currency).toBe("CAD");
          break;
        case "promise_as_paid":
          expect(p.resultKind).toBe("paid");
          break;
        case "wrong_category":
          expect(p.category).not.toBe(
            candidates.find((c) => c.key === p.originalKey)?.category,
          );
          break;
        case "unsupported_resolution":
          expect(p.resolution).toBe("resolved");
          break;
      }
    }
  });
  it("does not invent a numberless line or a currency", () => {
    const plants = Array.from({ length: 20 }, (_, i) =>
      plantDefects(`${i}`, [
        { ...candidates[0], numberlessProspectLines: [], currency: undefined },
      ]),
    ).flat();
    expect(
      plants.some(
        (p) =>
          p.plantedDefect === "invented_income" ||
          p.plantedDefect === "wrong_currency",
      ),
    ).toBe(false);
    const cad = Array.from({ length: 20 }, (_, i) =>
      plantDefects(`${i}`, [{ ...candidates[0], currency: "CAD" }]),
    ).flat();
    expect(
      cad.find((p) => p.plantedDefect === "wrong_currency")?.currency,
    ).toBe("USD");
  });
});
