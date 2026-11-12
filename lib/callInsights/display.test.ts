import { describe, expect, it } from "vitest";
import {
  changedFields,
  costLabel,
  formatMinorPlain,
  goalLine,
  incomeLine,
  minorToInput,
  modelLabel,
  moneyPhrase,
  noteSentences,
  notReadReason,
  quoteLine,
  readingsLine,
  readingWords,
  resolutionWord,
  suggestionHeadline,
} from "./display";

const when = (at: number) => `at ${at}`;
const base = { tier: "ready" as const, values: {} };

describe("money", () => {
  it("formats minor units without a currency", () => {
    expect(formatMinorPlain(170_000)).toBe("1,700");
    expect(formatMinorPlain(170_050)).toBe("1,700.50");
    expect(minorToInput(170_000)).toBe("1700");
    expect(minorToInput(170_050)).toBe("1700.5");
  });

  it("reads single amounts, ranges and open ends", () => {
    expect(
      moneyPhrase(
        {
          minMinor: 600_000,
          maxMinor: 600_000,
          currency: "USD",
          period: "month",
        },
        { approx: true },
      ),
    ).toBe("about 6,000 USD a month");
    expect(
      moneyPhrase({
        minMinor: 400_000,
        maxMinor: 700_000,
        currency: "USD",
        period: "month",
      }),
    ).toBe("4,000 to 7,000 USD a month");
    expect(moneyPhrase({ minMinor: 1_000_000 })).toBe("at least 10,000");
    expect(moneyPhrase({})).toBeNull();
  });

  it("writes income rows with the currency rules", () => {
    expect(
      incomeLine({
        label: "Business revenue",
        minMinor: 600_000,
        maxMinor: 600_000,
        currency: "USD",
        period: "month",
      }),
    ).toBe("Business revenue · about 6,000 USD a month");
    expect(
      incomeLine({
        label: "Personal income",
        minMinor: 600_000,
        maxMinor: 600_000,
        currency: "USD",
        currencyAssumed: true,
        period: "month",
      }),
    ).toBe("Personal income · about 6,000 USD (assumed) a month");
    expect(
      incomeLine({
        label: "Business revenue",
        minMinor: 600_000,
        maxMinor: 600_000,
        period: "month",
      }),
    ).toBe("Business revenue · about 6,000 a month · currency not stated");
    expect(
      incomeLine({
        label: "Business revenue",
        minMinor: 2_000_000,
        currency: "USD",
        period: "month",
        scenario: "target",
      }),
    ).toBe("Business revenue · at least 20,000 USD a month · target");
    expect(incomeLine({ label: "Savings" })).toBe("Savings");
  });

  it("writes goal rows with target and deadline", () => {
    expect(
      goalLine({
        label: "Revenue growth",
        minMinor: 1_500_000,
        maxMinor: 1_500_000,
        currency: "USD",
        period: "month",
        deadline: "by summer",
      }),
    ).toBe("Revenue growth · 15,000 USD a month · by summer");
    expect(goalLine({ label: "Time & lifestyle freedom" })).toBe(
      "Time & lifestyle freedom",
    );
  });

  it("names resolutions", () => {
    expect(resolutionWord("unresolved")).toBe("Open");
    expect(resolutionWord("resolved")).toBe("Resolved");
    expect(resolutionWord("unknown")).toBeNull();
    expect(resolutionWord(undefined)).toBeNull();
  });
});

describe("not read and admin footer", () => {
  it("has words for every reason", () => {
    expect(notReadReason("other_prospect")).toBe(
      "The recording is another prospect's call.",
    );
    expect(notReadReason("cap_reached")).toBe("The monthly limit was reached.");
    expect(notReadReason(undefined)).toBe("No reason was recorded.");
  });

  it("names models and costs", () => {
    expect(modelLabel("anthropic/claude-sonnet-5.5")).toBe("Sonnet 5.5");
    expect(modelLabel("anthropic/claude-opus-5.5")).toBe("Opus 5.5");
    expect(costLabel(0.0312)).toBe("$0.03");
    expect(costLabel(0.001)).toBe("under $0.01");
    expect(costLabel(0)).toBe("$0.00");
  });
});

describe("suggestion headline", () => {
  it("reads a payment with what is known", () => {
    expect(
      suggestionHeadline(
        {
          ...base,
          kind: "paid",
          values: {
            amountMinor: 170_000,
            currency: "USD",
            paymentType: "split",
          },
          amountHintMinor: 170_000,
          programName: "Scale Accelerator",
        },
        when,
      ),
    ).toBe("Won · 1,700 USD now · split · Scale Accelerator");
    expect(
      suggestionHeadline({ ...base, kind: "paid", values: {} }, when),
    ).toBe("Won");
    expect(
      suggestionHeadline(
        {
          ...base,
          kind: "paid",
          values: { currency: "USD", currencyAssumed: true },
          amountHintMinor: 170_000,
        },
        when,
      ),
    ).toBe("Won · 1,700 USD (assumed) now");
  });

  it("reads the other kinds", () => {
    expect(
      suggestionHeadline(
        {
          ...base,
          kind: "promised",
          values: { currency: "USD" },
          amountHintMinor: 500_000,
        },
        when,
      ),
    ).toBe("Promised to pay · 5,000 USD");
    expect(
      suggestionHeadline(
        { ...base, kind: "call_back", values: { callbackAt: 42 } },
        when,
      ),
    ).toBe("Call back · at 42");
    expect(
      suggestionHeadline(
        { ...base, kind: "lost", values: { lossCategory: "price" } },
        when,
      ),
    ).toBe("Lost · Price or payment terms");
    expect(
      suggestionHeadline(
        { ...base, kind: "no_show", noShowTier: "certain" },
        when,
      ),
    ).toBe("No-show · only you spoke");
    expect(
      suggestionHeadline(
        { ...base, kind: "no_show", noShowTier: "review" },
        when,
      ),
    ).toBe("Probably a no-show");
    expect(
      suggestionHeadline(
        { ...base, tier: "unconfirmed", kind: "empty_recording" },
        when,
      ),
    ).toBe("Empty recording · listen first");
    expect(
      suggestionHeadline(
        { ...base, tier: "unconfirmed", kind: "no_decision" },
        when,
      ),
    ).toBe("No decision on the call");
  });

  it("puts both readings on a check", () => {
    expect(
      suggestionHeadline(
        {
          ...base,
          tier: "check",
          kind: "paid",
          claudeReading: "payment",
          jevReading: "call_back 0.81",
        },
        when,
      ),
    ).toBe("Check this · a payment or a call back");
    expect(readingsLine("payment", "call_back 0.81")).toBe(
      "Claude heard a payment, Jev heard a call back",
    );
    expect(readingsLine("absent", "no_show 0.70 / held 0.66")).toBe(
      "Claude heard a no-show, Jev heard a no-show or a held call",
    );
    expect(readingsLine("payment", "missing")).toBe(
      "Claude heard a payment, Jev didn't answer",
    );
    expect(readingsLine(undefined, undefined)).toBeNull();
    expect(readingWords("paid 0.92")).toBe("a payment");
  });

  it("keeps only notes a person can act on", () => {
    expect(
      noteSentences(["models_disagree", "trace_incomplete", "wait_unset"]),
    ).toEqual([
      "Claude and Jev read the call differently. Listen before you choose.",
    ]);
    expect(noteSentences(["unknown_code"])).toEqual([]);
  });

  it("writes quote lines", () => {
    expect(quoteLine("31:52", "Okay, I'll do it.", "Prospect")).toBe(
      "31:52 · P: “Okay, I'll do it.”",
    );
    expect(quoteLine("04:18", "Too much.")).toBe("04:18 · “Too much.”");
  });
});

describe("changedFields", () => {
  it("lists prefilled fields whose value changed", () => {
    expect(
      changedFields(
        {
          amountMinor: 170_000,
          currency: "USD",
          paymentType: "split",
          programId: undefined,
        },
        {
          amountMinor: 150_000,
          currency: "USD",
          paymentType: "split",
          programId: "p1",
        },
      ),
    ).toEqual(["amountMinor"]);
  });

  it("counts a cleared field as changed and ignores fields not prefilled", () => {
    expect(
      changedFields(
        { currency: "USD", lossCategory: "" },
        { currency: "", lossCategory: "price" },
      ),
    ).toEqual(["currency"]);
    expect(changedFields({}, { currency: "EUR" })).toEqual([]);
  });

  it("returns nothing when the prefill was kept", () => {
    expect(
      changedFields(
        { noShowReason: "no_response" },
        { noShowReason: "no_response" },
      ),
    ).toEqual([]);
  });
});
