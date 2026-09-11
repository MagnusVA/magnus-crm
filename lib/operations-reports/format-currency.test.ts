import { describe, expect, it } from "vitest";
import {
  formatAmountMinor,
  formatCompactAmountMinor,
  formatCurrency,
  getCurrencyFractionDigits,
} from "../format-currency";

describe("currency formatting", () => {
  it("treats stored amounts as fixed hundredths for every currency", () => {
    expect(formatAmountMinor(123450, "JPY")).toBe(
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "JPY",
      }).format(1234.5),
    );
    expect(formatAmountMinor(1234, "KWD")).toBe(
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "KWD",
      }).format(12.34),
    );
  });

  it("falls back to a labeled major amount for malformed currency codes", () => {
    expect(formatAmountMinor(12345, "custom coin")).toBe(
      "123.45 CUSTOM COIN",
    );
    expect(formatCompactAmountMinor(12345, "custom coin")).toBe(
      "123.45 CUSTOM COIN",
    );
    expect(formatCurrency(123.45, "custom coin")).toBe(
      "123.45 CUSTOM COIN",
    );
    expect(getCurrencyFractionDigits("custom coin")).toBe(2);
  });
});
