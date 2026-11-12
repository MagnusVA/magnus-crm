import { describe, expect, it } from "vitest";
import {
  barResultWords,
  campaignProgress,
  caseActionWords,
  countedWords,
  judgeWords,
  labelTitle,
  labelValueWords,
  lineWords,
  lowerBoundWords,
  needsMoreWords,
  parseAmountMinor,
  parseArrivalMinutes,
  parseLine,
  pickLine,
  proposeMatches,
  resultValueRows,
  shareWords,
  sortCampaigns,
  tickedParts,
  upperBoundWords,
  valuesForKind,
  wrongFieldsFor,
  wrongPartOptions,
  wrongPartsWords,
} from "./quality-display";

describe("campaigns", () => {
  it("counts closed cases as graded", () => {
    expect(
      campaignProgress({
        to_read: 3,
        list_committed: 2,
        labels_committed: 4,
        closed: 1,
      }),
    ).toEqual({
      toRead: 3,
      listDone: 2,
      graded: 5,
    });
    expect(campaignProgress({})).toEqual({ toRead: 0, listDone: 0, graded: 0 });
  });

  it("sorts newest date first, then by name", () => {
    const sorted = sortCampaigns([
      { campaign: "b-2026-11-01" },
      { campaign: "a-2026-11-12" },
      { campaign: "c-2026-11-12" },
    ]);
    expect(sorted.map((c) => c.campaign)).toEqual([
      "a-2026-11-12",
      "c-2026-11-12",
      "b-2026-11-01",
    ]);
  });

  it("offers Grade until a case is graded", () => {
    expect(caseActionWords("to_read")).toBe("Grade");
    expect(caseActionWords("list_committed")).toBe("Grade");
    expect(caseActionWords("labels_committed")).toBe("Open");
  });
});

describe("items", () => {
  it("names lines and spans", () => {
    expect(lineWords(12)).toBe("#12");
    expect(lineWords(12, 12)).toBe("#12");
    expect(lineWords(12, 14)).toBe("#12–#14");
    expect(lineWords(undefined)).toBe("");
  });

  it("titles an item by class, category and lines", () => {
    expect(
      labelTitle({ itemClass: "objection", category: "price", lineStart: 12 }),
    ).toBe("Objection · Price · #12");
    expect(
      labelTitle({
        itemClass: "income",
        category: "business_revenue",
        lineStart: 3,
        lineEnd: 4,
      }),
    ).toBe("Income · Business revenue · #3–#4");
    expect(labelTitle({ itemClass: "attendance" })).toBe("No-show");
  });

  it("says an income item's values", () => {
    expect(
      labelValueWords({
        itemClass: "income",
        scenario: "current",
        minMinor: 400_000,
        maxMinor: 600_000,
        currency: "USD",
        period: "month",
      }),
    ).toEqual(["Current", "4,000 to 6,000 USD a month"]);
    expect(
      labelValueWords({
        itemClass: "income",
        minMinor: 100_000,
        maxMinor: 100_000,
      }),
    ).toEqual(["1,000", "currency not stated"]);
    expect(
      labelValueWords({ itemClass: "objection", resolution: "unresolved" }),
    ).toEqual(["Unresolved"]);
  });
});

describe("result values", () => {
  it("keeps only the values a kind uses", () => {
    expect(
      valuesForKind("lost", {
        lossCategory: "price",
        amountMinor: 100,
        currency: "USD",
        callbackAt: 5,
      }),
    ).toEqual({ lossCategory: "price" });
    expect(
      valuesForKind("paid", { amountMinor: 100, currencyAssumed: true }),
    ).toEqual({ amountMinor: 100 });
    expect(
      valuesForKind("paid", {
        amountMinor: 100,
        currency: "USD",
        currencyAssumed: true,
      }),
    ).toEqual({
      amountMinor: 100,
      currency: "USD",
      currencyAssumed: true,
    });
    expect(valuesForKind("no_decision", { lossCategory: "price" })).toEqual({});
  });

  it("lists a result's values in words", () => {
    expect(
      resultValueRows(
        {
          amountMinor: 150_000,
          currency: "USD",
          currencyAssumed: true,
          paymentType: "pif",
        },
        () => "x",
      ),
    ).toEqual([
      { field: "amountMinor", label: "Amount", value: "1,500" },
      { field: "currency", label: "Currency", value: "USD (assumed)" },
      { field: "paymentType", label: "Payment type", value: "Paid in full" },
    ]);
    expect(
      resultValueRows(
        { callbackAt: 1, contactMethod: "text" },
        () => "Nov 14, 3:00 PM",
      ),
    ).toEqual([
      { field: "callbackAt", label: "Call back", value: "Nov 14, 3:00 PM" },
      { field: "contactMethod", label: "Contact by", value: "Text" },
    ]);
  });
});

describe("wrong parts", () => {
  it("offers the brief's parts for an income item and maps amount to both bounds", () => {
    const parts = wrongPartOptions({ itemClass: "income" });
    expect(parts.map((p) => p.label)).toEqual([
      "Kind of income",
      "Amount",
      "Currency",
      "Period",
      "Current or target",
      "Speaker",
      "It isn't there",
    ]);
    expect(wrongFieldsFor(parts, new Set(["amount", "exists"]))).toEqual([
      "minMinor",
      "maxMinor",
      "exists",
    ]);
  });

  it("offers a result's parts only for the values it carries", () => {
    const parts = wrongPartOptions({
      itemClass: "result",
      resultValues: { amountMinor: 1, currency: "USD" },
    });
    expect(parts.map((p) => p.key)).toEqual([
      "resultKind",
      "resultTier",
      "amountMinor",
      "currency",
    ]);
    expect(wrongFieldsFor(parts, new Set(["currency"]))).toEqual([
      "currency",
      "currencyAssumed",
    ]);
  });

  it("sends only field names the backend accepts", () => {
    const accepted = new Set([
      "exists",
      "speaker",
      "category",
      "resolution",
      "scenario",
      "period",
      "currency",
      "currencyAssumed",
      "minMinor",
      "maxMinor",
      "kind",
      "resultKind",
      "tier",
      "resultTier",
      "amountMinor",
      "paymentType",
      "programId",
      "callbackAt",
      "contactMethod",
      "lossCategory",
      "noShowReason",
      "attendance",
      "noShowTier",
    ]);
    const everyValue = {
      amountMinor: 1,
      currency: "USD",
      paymentType: "pif" as const,
      callbackAt: 1,
      contactMethod: "call" as const,
      lossCategory: "price" as const,
      noShowReason: "other" as const,
    };
    for (const itemClass of [
      "objection",
      "struggle",
      "goal",
      "income",
      "result",
      "attendance",
    ])
      for (const part of wrongPartOptions({
        itemClass,
        resultValues: everyValue,
      }))
        for (const field of part.fields) expect(accepted.has(field)).toBe(true);
  });

  it("restores ticks from stored fields and says them", () => {
    const parts = wrongPartOptions({ itemClass: "income" });
    expect([...tickedParts(parts, ["maxMinor"])]).toEqual(["amount"]);
    expect(wrongPartsWords(parts, ["minMinor", "maxMinor", "period"])).toBe(
      "amount, period",
    );
    expect(wrongPartsWords(parts, [])).toBe("the whole item");
  });
});

describe("proposeMatches", () => {
  const item = (
    labelId: string,
    lineStart: number,
    category = "price",
    itemClass = "objection",
    lineEnd?: number,
  ) => ({
    labelId,
    itemClass,
    category,
    lineStart,
    lineEnd,
  });

  it("matches nearest first and uses each reading item once", () => {
    expect(
      proposeMatches(
        [item("a", 10), item("b", 11)],
        [item("x", 11), item("y", 30)],
      ),
    ).toEqual([
      { labelId: "a", matchedLabelId: null },
      { labelId: "b", matchedLabelId: "x" },
    ]);
  });

  it("needs the same class and category, within two lines", () => {
    expect(proposeMatches([item("a", 10)], [item("x", 13)])).toEqual([
      { labelId: "a", matchedLabelId: null },
    ]);
    expect(proposeMatches([item("a", 10)], [item("x", 12)])).toEqual([
      { labelId: "a", matchedLabelId: "x" },
    ]);
    expect(proposeMatches([item("a", 10)], [item("x", 10, "timing")])).toEqual([
      { labelId: "a", matchedLabelId: null },
    ]);
    expect(
      proposeMatches(
        [item("a", 10, "price", "objection", 20)],
        [item("x", 22)],
      ),
    ).toEqual([{ labelId: "a", matchedLabelId: "x" }]);
  });
});

describe("form input", () => {
  it("parses amounts in hundredths", () => {
    expect(parseAmountMinor("1,500.50")).toBe(150_050);
    expect(parseAmountMinor("0")).toBe(0);
    expect(parseAmountMinor(" ")).toBeNull();
    expect(parseAmountMinor("-5")).toBeNaN();
    expect(parseAmountMinor("1.234")).toBeNaN();
    expect(parseAmountMinor("abc")).toBeNaN();
  });

  it("checks lines against the transcript", () => {
    expect(parseLine("12", 40)).toBe(12);
    expect(parseLine("0", 40)).toBeNull();
    expect(parseLine("41", 40)).toBeNull();
    expect(parseLine("1.5", 40)).toBeNull();
  });

  it("parses arrival minutes, early ones too", () => {
    expect(parseArrivalMinutes("6")).toBe(6);
    expect(parseArrivalMinutes("-1.5")).toBe(-1.5);
    expect(parseArrivalMinutes("")).toBeNull();
    expect(parseArrivalMinutes("soon")).toBeNull();
  });

  it("fills the start, then the end, from clicked lines", () => {
    const first = pickLine({ lineStart: "", lineEnd: "", target: "start" }, 12);
    expect(first).toEqual({ lineStart: "12", lineEnd: "12", target: "end" });
    expect(pickLine(first, 15)).toEqual({
      lineStart: "12",
      lineEnd: "15",
      target: "start",
    });
    expect(pickLine(first, 9)).toEqual({
      lineStart: "9",
      lineEnd: "12",
      target: "start",
    });
    expect(
      pickLine({ lineStart: "12", lineEnd: "15", target: "start" }, 20),
    ).toEqual({
      lineStart: "20",
      lineEnd: "20",
      target: "end",
    });
  });
});

describe("bars and Opus", () => {
  it("says results, floors and bounds", () => {
    expect(barResultWords("inconclusive")).toBe("Not enough yet");
    expect(needsMoreWords({ n: 14, calls: 6, floor: 20 }, 10)).toBe(
      "needs 6 more items and 4 more calls",
    );
    expect(needsMoreWords({ n: 19, calls: 12, floor: 20 }, 10)).toBe(
      "needs 1 more item",
    );
    expect(needsMoreWords({ n: 20, calls: 10, floor: 20 }, 10)).toBeNull();
    expect(lowerBoundWords(0.8799)).toBe("at least 87% right (95% confidence)");
    expect(lowerBoundWords(undefined)).toBeNull();
    expect(countedWords({ n: 1, calls: 1 })).toBe("1 item · 1 call");
  });

  it("says Opus's verdicts and agreement", () => {
    expect(judgeWords("insufficient")).toBe("not enough to tell");
    expect(judgeWords(undefined)).toBeNull();
    expect(shareWords(27, 30)).toBe("27 of 30 (90%)");
    expect(shareWords(0, 0)).toBe("—");
  });

  it("rounds wait bounds up", () => {
    expect(upperBoundWords(0.0494)).toBe("5.0%");
    expect(upperBoundWords(0.049)).toBe("4.9%");
    expect(upperBoundWords(1)).toBe("100.0%");
  });
});
