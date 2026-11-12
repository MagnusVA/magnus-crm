import { describe, expect, it } from "vitest";
import {
  callCount,
  callStatusTone,
  callStatusWord,
  checkResultWords,
  checkWarning,
  comparisonWords,
  formatUsd,
  incomeBandOrder,
  incomeBandWords,
  noShowTierWords,
  percentOf,
  reasonWords,
  recordedKindWords,
  suggestionTierWords,
} from "./report-display";

describe("percentOf", () => {
  it("rounds to a whole percent", () => {
    expect(percentOf(1, 3)).toBe("33%");
    expect(percentOf(2, 3)).toBe("67%");
    expect(percentOf(5, 5)).toBe("100%");
  });
  it("says nothing to divide by as a dash", () => {
    expect(percentOf(0, 0)).toBe("—");
    expect(percentOf(3, -1)).toBe("—");
    expect(percentOf(Number.NaN, 4)).toBe("—");
  });
});

describe("numbers", () => {
  it("formats spend and counts", () => {
    expect(formatUsd(3.1)).toBe("$3.10");
    expect(formatUsd(0.336)).toBe("$0.34");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
    expect(callCount(1)).toBe("1 call");
    expect(callCount(1200)).toBe("1,200 calls");
  });
});

describe("call status", () => {
  it("folds stored statuses into four words", () => {
    expect(callStatusWord("answered")).toBe("Read");
    expect(callStatusWord("queued")).toBe("Reading");
    expect(callStatusWord("running")).toBe("Reading");
    expect(callStatusWord("checking")).toBe("Reading");
    expect(callStatusWord("waiting")).toBe("Waiting");
    expect(callStatusWord("failed")).toBe("Not read");
    expect(callStatusWord("skipped")).toBe("Not read");
  });
  it("colours by meaning", () => {
    expect(callStatusTone("answered")).toBe("live");
    expect(callStatusTone("waiting")).toBe("owed");
    expect(callStatusTone("failed")).toBe("failed");
    expect(callStatusTone("skipped")).toBe("done");
  });
  it("says every reason in words", () => {
    expect(reasonWords("other_prospect")).toBe(
      "The recording is another prospect's call",
    );
    expect(reasonWords("cap_reached")).toBe("The monthly limit was reached");
    expect(reasonWords(undefined)).toBe("No reason was recorded");
    expect(reasonWords("unknown")).toBe("No reason was recorded");
    expect(reasonWords("toString")).toBe("No reason was recorded");
  });
});

describe("suggestion words", () => {
  it("labels tiers, no-show tiers and recorded results", () => {
    expect(suggestionTierWords("ready")).toBe("Confirmed by Jev");
    expect(suggestionTierWords("check")).toBe("Check this");
    expect(noShowTierWords("certain")).toBe("Clear no-show");
    expect(noShowTierWords("mystery")).toBe("mystery");
    expect(recordedKindWords("held_other")).toBe("Held, other result");
    expect(recordedKindWords("??")).toBe("Other result");
    expect(comparisonWords("different_result")).toBe("Different result");
    expect(comparisonWords("same_result_different_values")).toBe(
      "Same result, different amount",
    );
  });
});

describe("capability checks", () => {
  it("names each result and warns unless passed", () => {
    expect(checkResultWords("pass")).toBe("Checks passed");
    expect(checkResultWords("fail")).toBe("Checks failing");
    expect(checkResultWords("inconclusive")).toBe(
      "Not enough graded calls yet",
    );
    expect(checkWarning("pass")).toBeNull();
    expect(checkWarning("fail")).toMatch(/failing/);
    expect(checkWarning(undefined)).toMatch(/graded/);
  });
});

describe("incomeBandWords", () => {
  it("reads personal income bands", () => {
    expect(incomeBandWords("personal_income", "b0")).toBe("Nothing");
    expect(incomeBandWords("personal_income", "b1")).toBe("Under $1k");
    expect(incomeBandWords("personal_income", "b1000")).toBe("$1k–3k");
    expect(incomeBandWords("personal_income", "b5000")).toBe("$5k–10k");
    expect(incomeBandWords("personal_income", "b20000")).toBe("$20k+");
  });
  it("reads business revenue and savings bands", () => {
    expect(incomeBandWords("business_revenue", "b1")).toBe("Under $5k");
    expect(incomeBandWords("business_revenue", "b100000")).toBe("$100k+");
    expect(incomeBandWords("savings", "b0")).toBe("Under $1k");
  });
  it("names the special rows and passes unknown keys through", () => {
    expect(incomeBandWords("personal_income", "spans_bands")).toBe(
      "Spans bands",
    );
    expect(incomeBandWords("personal_income", "currency_not_stated")).toBe(
      "Currency not stated",
    );
    expect(incomeBandWords("budget", "other_currency")).toBe("Other currency");
    expect(incomeBandWords("budget", "no_monthly_equivalent")).toBe(
      "No monthly equivalent",
    );
    expect(incomeBandWords("personal_income", "b777")).toBe("b777");
    expect(incomeBandWords("business_profit", "b1000")).toBe("b1000");
  });
  it("sorts money bands low to high, then the special rows", () => {
    const sorted = ["spans_bands", "b5000", "currency_not_stated", "b1"].sort(
      (a, b) => incomeBandOrder(a) - incomeBandOrder(b),
    );
    expect(sorted).toEqual([
      "b1",
      "b5000",
      "spans_bands",
      "currency_not_stated",
    ]);
  });
});
