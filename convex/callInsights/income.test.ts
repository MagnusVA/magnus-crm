import { expect, test } from "vitest";
import { parseAmounts, incomeBandFor } from "./income";
test.each([
  ["6k", [6000]],
  ["6,000", [6000]],
  ["6.000", [6000]],
  ["6,000.50", [6000.5]],
  ["6.000,50", [6000.5]],
  ["80 grand", [80000]],
  ["seis mil", [6000]],
  ["cinco lucas", [5000]],
  ["three thousand", [3000]],
  ["one hundred thousand", [100000]],
  ["quinientos", [500]],
  ["treinta y cinco mil", [35000]],
  ["twenty-five thousand", [25000]],
  ["six thousand five hundred", [6500]],
  ["between 6k and 8k", [6000, 8000]],
  ["6,000 to 8,000", [6000, 8000]],
  ["at least 10k", [10000]],
  ["6-8k", [6000, 8000]],
  ["6 a 8 mil", [6000, 8000]],
  ["$45 an hour", [45]],
  ["No amount here", []],
] as const)("parses %s", (text, amounts) =>
  expect(parseAmounts(text)).toEqual(amounts),
);
test.each([
  ["personal_income", "USD", 499999, 499999, false, "b3000"],
  ["personal_income", "USD", 500000, 500000, false, "b5000"],
  ["personal_income", "USD", 400000, 600000, false, "spans_bands"],
  ["personal_income", "USD", 1000000, undefined, false, "spans_bands"],
  ["personal_income", undefined, 500000, 500000, false, "currency_not_stated"],
  ["personal_income", "CAD", 500000, 500000, false, "other_currency"],
  [
    "personal_income",
    "USD",
    undefined,
    undefined,
    false,
    "no_monthly_equivalent",
  ],
  ["personal_income", "USD", 500000, 500000, true, "speaker_unclear"],
  ["business_revenue", "USD", 500000, 500000, false, "b5000"],
  ["business_profit", "USD", 500000, 500000, false, undefined],
] as const)("bands %s %s %s %s", (kind, currency, min, max, uncertain, band) =>
  expect(incomeBandFor(kind, currency, min, max, uncertain)).toBe(band),
);
