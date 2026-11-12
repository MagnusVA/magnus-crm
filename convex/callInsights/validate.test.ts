import { describe, expect, test } from "vitest";
import {
  parseExtraction,
  parseAttendanceOnly,
  type RawExtraction,
} from "./parse";
import { prepareTranscript } from "./transcriptPrep";
import { validateAttendance, validateExtraction } from "./validate";
import { flatAnswer, flatAttendance } from "../../tests/callInsightsFlat";
const recorder = { email: "closer@example.test", names: ["Closer"] };
const p = "prospect@example.test";
const options = {
  timeZone: "America/Tegucigalpa",
  now: Date.parse("2026-11-12T00:00:00Z"),
};
const blankAttendance = () => ({
  reading: "unclear",
  waiting: [],
  leaving: [],
  triedToReach: [],
  someoneThere: [],
  secondPerson: [],
  notSalesCall: [],
});
function raw(patch: Record<string, unknown> = {}): RawExtraction {
  return parseExtraction(
    JSON.stringify(flatAnswer({ attendance: blankAttendance(), ...patch })),
  );
}
const transcript = (texts: string[]) =>
  prepareTranscript(
    texts.map((text, index) => ({
      atSeconds: index * 60,
      speakerEmail: index === 0 ? recorder.email : p,
      text,
    })),
    recorder,
    [p],
  );
const item = (quote: string, lineIndex = 2, category = "price") => ({
  category,
  statement: "The amount is too high.",
  quote,
  lineIndex,
  resolution: "unknown",
});
const income = (
  quote: string,
  amountMin = "6000",
  fields: Record<string, unknown> = {},
) => ({
  kind: "personal_income",
  scenario: "current",
  amountMin,
  amountMax: amountMin,
  currencyAsSaid: "dollars_unspecified",
  period: "month",
  statement: "They earn money monthly.",
  quote,
  lineIndex: 2,
  ...fields,
});
const payment = (quote: string, fields: Record<string, unknown> = {}) => ({
  kind: "paid",
  amount: "1700",
  amountRole: "this_payment",
  currencyAsSaid: "dollars_unspecified",
  paymentType: "deposit",
  quotes: [{ label: "Agreed", quote, lineIndex: 2 }],
  ...fields,
});

describe("item evidence", () => {
  test("finds a quote on a neighbouring line and uses the real time and index", () => {
    const out = validateExtraction(
      raw({
        objections: [item("It costs too much", 3)],
        primaryBlocker: "price",
      }),
      transcript(["Hello", "It costs too much", "What about next month?"]),
      options,
    );
    expect(out.items).toEqual([
      expect.objectContaining({
        key: "objection:0",
        lineIndex: 2,
        atSeconds: 60,
        check: "unchecked",
      }),
    ]);
    expect(out.primaryBlockerExtracted).toBe("price");
  });
  test("matches accents, case, punctuation and spacing", () => {
    const out = validateExtraction(
      raw({ objections: [item("si cuesta mucho")] }),
      transcript(["Hello", "¡SÍ, cuesta  mucho!"]),
      options,
    );
    expect(out.items).toHaveLength(1);
  });
  test("drops invented, closer, card-number and bad-category items", () => {
    const out = validateExtraction(
      raw({
        objections: [
          item("Not here"),
          item("Hello", 1),
          item("my card", 3),
          item("Too much", 4, "invented"),
        ],
      }),
      transcript([
        "Hello",
        "Fine",
        "my card is 4111 1111 1111 1111",
        "Too much",
      ]),
      options,
    );
    expect(out.items).toEqual([]);
    expect(out.dropped).toMatchObject({
      quoteNotFound: 1,
      notProspect: 1,
      cardNumber: 1,
      badCategory: 1,
    });
    expect(out.primaryBlockerExtracted).toBeUndefined();
  });
  test("keys count only survivors in each kind and follow output order", () => {
    const out = validateExtraction(
      raw({
        objections: [item("Invented"), item("Too much"), item("Too much")],
        struggles: [{ ...item("Too much", 2, "cashflow_profitability") }],
      }),
      transcript(["Hello", "Too much"]),
      options,
    );
    expect(out.items.map((item) => item.key)).toEqual([
      "objection:0",
      "objection:1",
      "struggle:0",
    ]);
  });
  test("caps every item list, statement and quote", () => {
    const quote = "A".repeat(401);
    const out = validateExtraction(
      raw({
        objections: Array.from({ length: 13 }, () => item("Too much")),
        struggles: Array.from({ length: 11 }, () => ({
          ...item("Too much", 2, "other"),
        })),
        goals: Array.from({ length: 11 }, () => ({
          ...item("Too much", 2, "other"),
        })),
        income: Array.from({ length: 13 }, () => income("6000 dollars")),
      }),
      transcript(["Hello", "Too much 6000 dollars"]),
      options,
    );
    expect(out.items).toHaveLength(44);
    expect(out.dropped.overLimit).toBe(4);
    const lengths = validateExtraction(
      raw({
        objections: [
          { ...item("Too much"), statement: "x".repeat(201) },
          item(quote),
        ],
      }),
      transcript(["Hello", quote]),
      options,
    );
    expect(lengths.items).toEqual([]);
    expect(lengths.dropped.overLimit).toBe(2);
  });
  test("resolved needs later prospect agreement; closer reassurance and missing evidence become unknown", () => {
    const t = prepareTranscript(
      [
        { atSeconds: 0, speakerEmail: recorder.email, text: "Welcome" },
        { atSeconds: 1, speakerEmail: p, text: "Too much" },
        { atSeconds: 2, speakerEmail: recorder.email, text: "It is worth it" },
        { atSeconds: 3, speakerEmail: p, text: "That settles it" },
      ],
      recorder,
      [p],
    );
    const objections = [
      { ...item("Too much"), resolution: "resolved" },
      {
        ...item("Too much"),
        resolution: "resolved",
        resolutionQuote: "It is worth it",
        resolutionLineIndex: 3,
      },
      {
        ...item("Too much"),
        resolution: "resolved",
        resolutionQuote: "That settles it",
        resolutionLineIndex: 4,
      },
    ];
    expect(
      validateExtraction(raw({ objections }), t, options).items.map(
        (item) => item.resolution,
      ),
    ).toEqual(["unknown", "unknown", "resolved"]);
    expect(
      validateExtraction(
        raw({
          objections: [
            {
              ...item("That settles it", 4),
              resolution: "resolved",
              resolutionQuote: "Too much",
              resolutionLineIndex: 2,
            },
          ],
        }),
        t,
        options,
      ).items[0].resolution,
    ).toBe("unknown");
  });
});
describe("income evidence", () => {
  test.each([
    ["6k", "6000"],
    ["6,000", "6000"],
    ["80 grand", "80000"],
    ["seis mil", "6000"],
    ["cinco lucas", "5000"],
    ["three thousand", "3000"],
  ])("accepts %s as %s", (quote, amount) => {
    const out = validateExtraction(
      raw({ income: [income(quote, amount)] }),
      transcript(["Hello", quote]),
      options,
    );
    expect(out.items[0]).toMatchObject({
      minMinor: Number(amount) * 100,
      maxMinor: Number(amount) * 100,
      currency: "USD",
      currencyAssumed: true,
    });
  });
  test("three thousand cannot support a model amount of 30000", () => {
    const out = validateExtraction(
      raw({ income: [income("three thousand", "30000")] }),
      transcript(["Hello", "three thousand"]),
      options,
    );
    expect(out.items).toEqual([]);
    expect(out.dropped.amountNotInQuote).toBe(1);
  });
  test("checks both range endpoints and preserves open-ended amounts", () => {
    const quote = "I earn 6k to 8k dollars monthly";
    const out = validateExtraction(
      raw({
        income: [
          income(quote, "6000", { amountMax: "8000" }),
          income(quote, "6000", { amountMax: "9000" }),
        ],
      }),
      transcript(["Hello", quote]),
      options,
    );
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ minMinor: 600000, maxMinor: 800000 });
    const open = validateExtraction(
      raw({ income: [income("at least 10k", "10000", { amountMax: null })] }),
      transcript(["Hello", "at least 10k"]),
      options,
    ).items[0];
    expect(open.minMinor).toBe(1000000);
    expect(open.maxMinor).toBeUndefined();
    expect(open.band).toBe("spans_bands");
  });
  test("bare dollars are assumed USD, a dollar symbol has no currency or monthly equivalent", () => {
    const quote = "$45 an hour";
    const item = validateExtraction(
      raw({
        income: [
          income(quote, "45", {
            period: "hour",
            currencyAsSaid: "symbol_only",
          }),
        ],
      }),
      transcript(["Hello", quote]),
      options,
    ).items[0];
    expect(item.minMinor).toBe(4500);
    expect(item.currency).toBeUndefined();
    expect(item.monthlyMinMinor).toBeUndefined();
    expect(item.band).toBe("currency_not_stated");
  });
  test.each([
    ["year", "60000", 500000],
    ["week", "1200", 520000],
    ["month", "5000", 500000],
  ])("converts %s to monthly minor units", (period, amount, monthly) => {
    const quote = `I earn ${amount} dollars per ${period}`;
    const result = validateExtraction(
      raw({ income: [income(quote, amount, { period })] }),
      transcript(["Hello", quote]),
      options,
    ).items[0];
    expect(result.monthlyMinMinor).toBe(monthly);
    expect(result.band).toBe("b5000");
  });
  test("a range across bands and uncertain speakers get their special bands", () => {
    const quote = "4000 to 6000 dollars";
    expect(
      validateExtraction(
        raw({ income: [income(quote, "4000", { amountMax: "6000" })] }),
        transcript(["Hello", quote]),
        options,
      ).items[0].band,
    ).toBe("spans_bands");
    const t = prepareTranscript(
      [{ atSeconds: 1, speakerEmail: p, text: quote }],
      recorder,
      [p],
    );
    const out = validateExtraction(
      raw({
        income: [income(quote, "4000", { amountMax: "6000", lineIndex: 1 })],
      }),
      t,
      options,
    );
    expect(out.speakerUncertain).toBe(true);
    expect(out.items[0].band).toBe("speaker_unclear");
  });
  test("validates stated goal amounts and keeps the deadline as spoken", () => {
    const quote = "I want 10k dollars by summer";
    const out = validateExtraction(
      raw({
        goals: [
          {
            ...item(quote, 2, "revenue_growth"),
            targetAmount: "10000",
            targetAmountMax: "10000",
            targetCurrency: "dollars_unspecified",
            targetPeriod: "month",
            deadline: "by summer",
          },
        ],
      }),
      transcript(["Hello", quote]),
      options,
    );
    expect(out.items[0]).toMatchObject({
      scenario: "target",
      minMinor: 1000000,
      deadline: "by summer",
      currency: "USD",
    });
  });
});
describe("result evidence", () => {
  test("paid with prospect agreement and quoted amount passes", () => {
    const quote = "Yes, I paid 1700 dollars";
    const result = validateExtraction(
      raw({ result: payment(quote) }),
      transcript(["Hello", quote]),
      options,
    ).result;
    expect(result.codeChecksPassed).toBe(true);
    expect(result.values).toMatchObject({
      amountMinor: 170000,
      currency: "USD",
      currencyAssumed: true,
      paymentType: "deposit",
    });
  });
  test("closer-only evidence, missing amount, full-price role and unclear speakers fail", () => {
    const quote = "You paid 1700 dollars";
    const t = prepareTranscript(
      [{ atSeconds: 0, speakerEmail: recorder.email, text: quote }],
      recorder,
      [],
    );
    expect(
      validateExtraction(
        raw({
          result: payment(quote, {
            quotes: [{ label: "Paid", quote, lineIndex: 1 }],
          }),
        }),
        t,
        options,
      ).result.failedChecks,
    ).toContain("no_prospect_agreement");
    expect(
      validateExtraction(
        raw({ result: payment("I agree", { amountRole: "full_price" }) }),
        transcript(["Hello", "I agree"]),
        options,
      ).result.failedChecks,
    ).toEqual(expect.arrayContaining(["amount_not_in_quote", "amount_role"]));
    const noCloser = prepareTranscript(
      [{ atSeconds: 0, speakerEmail: p, text: quote }],
      recorder,
      [p],
    );
    expect(
      validateExtraction(
        raw({
          result: payment(quote, {
            quotes: [{ label: "Paid", quote, lineIndex: 1 }],
          }),
        }),
        noCloser,
        options,
      ).result.failedChecks,
    ).toContain("speaker_unclear");
  });
  test("a later different payment amount fails, a different nonpayment number does not", () => {
    const quote = "Yes I will pay 1700 dollars";
    const r = raw({ result: payment(quote, { kind: "promised" }) });
    expect(
      validateExtraction(
        r,
        transcript(["Hello", quote, "The deposit is 2000"]),
        options,
      ).result.failedChecks,
    ).toContain("later_amount");
    expect(
      validateExtraction(
        r,
        transcript(["Hello", quote, "I was born in 1990"]),
        options,
      ).result.codeChecksPassed,
    ).toBe(true);
  });
  test("future callback converts tenant local time, defaults to call, and rejects past or invalid dates", () => {
    const quote = "Call me tomorrow at ten";
    const callback = (date: string) =>
      raw({
        result: {
          kind: "call_back",
          quotes: [{ label: "Call", quote, lineIndex: 2 }],
          callbackDateTimeLocal: date,
        },
      });
    const t = transcript(["Hello", quote]);
    const result = validateExtraction(
      callback("2026-11-13T10:15:30"),
      t,
      options,
    ).result;
    expect(result.codeChecksPassed).toBe(true);
    expect(result.values).toMatchObject({
      callbackAt: Date.parse("2026-11-13T16:15:30Z"),
      contactMethod: "call",
    });
    for (const date of [
      "2020-01-01T10:00",
      "2026-02-30T10:00",
      "2026-11-13T25:00",
      "2026-11-13T10:00Z",
    ])
      expect(
        validateExtraction(callback(date), t, options).result.codeChecksPassed,
      ).toBe(false);
  });
  test("lost requires a known loss category", () => {
    const quote = "I do not want to buy";
    const lost = (lossCategory: string) =>
      raw({
        result: {
          kind: "lost",
          lossCategory,
          quotes: [{ label: "Declined", quote, lineIndex: 2 }],
        },
      });
    expect(
      validateExtraction(lost("price"), transcript(["Hello", quote]), options)
        .result.codeChecksPassed,
    ).toBe(true);
    expect(
      validateExtraction(lost("made_up"), transcript(["Hello", quote]), options)
        .result.failedChecks,
    ).toContain("bad_loss_category");
  });
  test("result quotes enforce matching, card privacy and six-quote limit", () => {
    const quote = "my card 4111111111111111";
    const out = validateExtraction(
      raw({
        result: payment(quote, {
          quotes: [
            { label: "Missing", quote: "invented", lineIndex: 2 },
            ...Array.from({ length: 6 }, () => ({
              label: "Card",
              quote,
              lineIndex: 2,
            })),
          ],
        }),
      }),
      transcript(["Hello", quote]),
      options,
    );
    expect(out.result.quotes).toEqual([]);
    expect(out.result.codeChecksPassed).toBe(false);
    expect(out.dropped).toMatchObject({
      overLimit: 1,
      quoteNotFound: 1,
      cardNumber: 5,
    });
  });
});
describe("attendance evidence", () => {
  test("waiting starts at +5:00 inclusive and leaving is in the last 120 seconds", () => {
    const t = prepareTranscript(
      [
        {
          atSeconds: 309,
          speakerEmail: recorder.email,
          text: "I am still waiting early",
        },
        {
          atSeconds: 310,
          speakerEmail: recorder.email,
          text: "I am still waiting now",
        },
        {
          atSeconds: 479,
          speakerEmail: recorder.email,
          text: "I will leave early",
        },
        {
          atSeconds: 480,
          speakerEmail: recorder.email,
          text: "I am leaving now",
        },
        { atSeconds: 590, speakerEmail: p, text: "I am waiting too" },
      ],
      recorder,
      [p],
    );
    const a = parseAttendanceOnly(
      JSON.stringify(
        flatAttendance({
          ...blankAttendance(),
          reading: "absent",
          waiting: [
            { quote: "I am still waiting early", lineIndex: 1 },
            { quote: "I am still waiting now", lineIndex: 2 },
            { quote: "I am waiting too", lineIndex: 5 },
          ],
          leaving: [
            { quote: "I will leave early", lineIndex: 3 },
            { quote: "I am leaving now", lineIndex: 4 },
          ],
          reachOutcome: "trouble_joining",
        }),
      ),
    );
    const out = validateAttendance(a, t, 10, 600);
    expect(out.waiting.map((q) => q.lineIndex)).toEqual([2]);
    expect(out.leaving.map((q) => q.lineIndex)).toEqual([4]);
    expect(out.suggestedReason).toBe("technical_issues");
  });
  test("reach must be closer, other lists accept any speaker; privacy applies to every list", () => {
    const t = transcript([
      "I tried calling",
      "Someone is here",
      "Card 4111111111111111",
    ]);
    const a = parseAttendanceOnly(
      JSON.stringify(
        flatAttendance({
          ...blankAttendance(),
          triedToReach: [
            { quote: "Someone is here", lineIndex: 2 },
            { quote: "I tried calling", lineIndex: 1 },
          ],
          someoneThere: [
            { quote: "Someone is here", lineIndex: 2 },
            { quote: "Card", lineIndex: 3 },
          ],
          secondPerson: [{ quote: "Someone is here", lineIndex: 2 }],
          notSalesCall: [{ quote: "Not here", lineIndex: 1 }],
          reachOutcome: "cant_make_it",
        }),
      ),
    );
    const out = validateAttendance(a, t, 0, 600);
    expect(out.triedToReach).toHaveLength(1);
    expect(out.someoneThere).toHaveLength(1);
    expect(out.secondPerson).toHaveLength(1);
    expect(out.notSalesCall).toEqual([]);
    expect(out.suggestedReason).toBe("late_cancel");
  });
  test("each attendance list is capped at six quotes", () => {
    const t = transcript(["Hello", "Someone is here"]);
    const a = parseAttendanceOnly(
      JSON.stringify(
        flatAttendance({
          ...blankAttendance(),
          someoneThere: Array.from({ length: 7 }, () => ({
            quote: "Someone is here",
            lineIndex: 2,
          })),
        }),
      ),
    );
    expect(validateAttendance(a, t, 0, 600).someoneThere).toHaveLength(6);
  });
});

describe("amounts are checked against the transcript, not the model's copy of it", () => {
  test("a quote that drops a decimal point cannot carry a larger amount", () => {
    const out = validateExtraction(
      raw({ result: payment("I'll pay 99750 today", { amount: "99750" }) }),
      transcript(["Hello", "Okay I'll pay 997.50 today."]),
      options,
    );
    expect(out.result.codeChecksPassed).toBe(false);
    expect(out.result.failedChecks).toContain("amount_not_in_quote");
    // The honest reading of the same line passes.
    const honest = validateExtraction(
      raw({ result: payment("I'll pay 997.50 today", { amount: "997.50" }) }),
      transcript(["Hello", "Okay I'll pay 997.50 today."]),
      options,
    );
    expect(honest.result).toMatchObject({
      codeChecksPassed: true,
      values: { amountMinor: 99_750 },
    });
  });

  test("a quote must match whole words: 170 is not found inside 1,700", () => {
    const out = validateExtraction(
      raw({ result: payment("Okay I'll pay 170", { amount: "170" }) }),
      transcript(["Hello", "Okay I'll pay 1,700 today."]),
      options,
    );
    expect(out.result.quotes).toEqual([]);
    expect(out.result.codeChecksPassed).toBe(false);
  });

  test("income quoted as 35k from a line that says 3.5k is dropped", () => {
    const out = validateExtraction(
      raw({ income: [income("35k", "35000")] }),
      transcript(["Hello", "I make 3.5k a month in dollars."]),
      options,
    );
    expect(out.items).toEqual([]);
    expect(out.dropped.amountNotInQuote).toBe(1);
  });

  test("a later amount fails the check even when the model cites that line", () => {
    const lines = [
      "Hello",
      "Okay, let's do the full 1700 payment.",
      "Great.",
      "Actually can I just put 500 down as a deposit today?",
    ];
    const both = validateExtraction(
      raw({
        result: payment("let's do the full 1700 payment", {
          quotes: [
            {
              label: "agreement",
              quote: "let's do the full 1700 payment",
              lineIndex: 2,
            },
            {
              label: "payment",
              quote: "can I just put 500 down as a deposit today",
              lineIndex: 4,
            },
          ],
        }),
      }),
      transcript(lines),
      options,
    );
    expect(both.result.failedChecks).toContain("later_amount");
    const one = validateExtraction(
      raw({ result: payment("let's do the full 1700 payment") }),
      transcript(lines),
      options,
    );
    expect(one.result.failedChecks).toContain("later_amount");
  });

  test("a payment of zero never passes, and Spanish payment words count", () => {
    const zero = validateExtraction(
      raw({ result: payment("I'll pay 0 today", { amount: "0" }) }),
      transcript(["Hello", "I'll pay 0 today"]),
      options,
    );
    expect(zero.result.codeChecksPassed).toBe(false);
    const spanish = validateExtraction(
      raw({ result: payment("Va, pago 500 hoy", { amount: "500" }) }),
      transcript([
        "Hola",
        "Va, pago 500 hoy.",
        "Mejor voy a pagar 1700 completo.",
      ]),
      options,
    );
    expect(spanish.result.failedChecks).toContain("later_amount");
  });
});
