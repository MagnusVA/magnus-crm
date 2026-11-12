import { describe, expect, test } from "vitest";
import type { NoShowTier } from "../../../lib/callInsights/taxonomy";
import type {
  AttendanceEvidence,
  EarlyReading,
  FoundQuote,
  ResultEvidence,
} from "../validators";
import { deriveSuggestion } from "./derive";

function quote(atSeconds = 1): FoundQuote {
  return {
    quote: "Synthetic quote",
    lineIndex: 1,
    atSeconds,
    speaker: "Prospect",
  };
}

function result(
  kind: ResultEvidence["kind"] = "paid",
  overrides: Partial<ResultEvidence> = {},
): ResultEvidence {
  return {
    kind,
    quotes: [{ ...quote(), label: "agreement" }],
    values:
      kind === "call_back"
        ? { callbackAt: 1_000_000, contactMethod: "text" }
        : kind === "lost"
          ? { lossCategory: "price" }
          : {
              amountMinor: 170_000,
              currency: "USD",
              currencyAssumed: true,
              paymentType: "split",
            },
    codeChecksPassed: true,
    failedChecks: [],
    ...overrides,
  };
}

function pair(
  choice: string,
  confidence = 0.8,
): NonNullable<EarlyReading["ending"]> {
  return {
    withSummary: { choice, confidence },
    withoutSummary: { choice, confidence },
  };
}

function reading(
  ending = "paid",
  overrides: Partial<EarlyReading> = {},
): EarlyReading {
  return {
    attendance: pair("held"),
    ending: pair(ending),
    resultCheck: 0.8,
    incomplete: false,
    ...overrides,
  };
}

function attendance(
  overrides: Partial<AttendanceEvidence> = {},
): AttendanceEvidence {
  return {
    reading: "absent",
    waiting: [quote(300)],
    leaving: [quote(590)],
    triedToReach: [quote(350)],
    someoneThere: [quote(400)],
    secondPerson: [quote(410)],
    notSalesCall: [],
    ...overrides,
  };
}

function args(
  overrides: Partial<Parameters<typeof deriveSuggestion>[0]> = {},
): Parameters<typeof deriveSuggestion>[0] {
  return {
    noShow: { tier: "none", notes: [] },
    result: result(),
    reading: reading(),
    ...overrides,
  };
}

describe("no-show priority and projection", () => {
  test.each([
    ["empty", "empty_recording", "unconfirmed"],
    ["certain", "no_show", "ready"],
    ["review", "no_show", "ready"],
    ["check", "no_show", "check"],
    ["unconfirmed", "no_show", "unconfirmed"],
  ] as const)(
    "%s wins over payment evidence and becomes %s / %s",
    (tier, kind, generalTier) => {
      const actual = deriveSuggestion(
        args({
          noShow: { tier, notes: ["weak_match"] },
          attendance: attendance(),
        }),
      );
      expect(actual).toMatchObject({
        kind,
        tier: generalTier,
        noShowTier: tier,
        notes: ["weak_match"],
        claudeReading: "absent",
      });
      expect(actual?.values).toEqual(
        generalTier === "ready" ? { noShowReason: "no_response" } : {},
      );
      expect(actual?.quotes.map((found) => found.label)).toEqual(
        tier === "check"
          ? [
              "Waiting",
              "Leaving",
              "Tried to reach them",
              "Someone is there",
              "Someone is there",
            ]
          : ["Waiting", "Leaving", "Tried to reach them"],
      );
    },
  );

  test.each(["no_response", "late_cancel", "technical_issues"] as const)(
    "ready no-show uses evidence reason %s",
    (suggestedReason) => {
      expect(
        deriveSuggestion(
          args({
            noShow: { tier: "review", notes: [] },
            attendance: attendance({ suggestedReason }),
          }),
        )?.values,
      ).toEqual({ noShowReason: suggestedReason });
    },
  );

  test("empty recording works without model evidence or imagined agreement", () => {
    expect(
      deriveSuggestion({
        noShow: { tier: "empty", notes: ["empty_recording"] },
      }),
    ).toMatchObject({
      kind: "empty_recording",
      tier: "unconfirmed",
      values: {},
      quotes: [],
      jevReading: "missing",
    });
  });

  test("carries quote provenance and supplied no-show notes unchanged", () => {
    const evidence = attendance();
    const actual = deriveSuggestion(
      args({
        noShow: { tier: "review", notes: ["no_leaving_quote", "weak_match"] },
        attendance: evidence,
      }),
    );
    expect(actual?.quotes[0]).toEqual({
      ...evidence.waiting[0],
      label: "Waiting",
    });
    expect(actual?.notes).toEqual(["no_leaving_quote", "weak_match"]);
  });

  test("None allows the regular result path", () => {
    expect(deriveSuggestion(args())?.kind).toBe("paid");
    expect(deriveSuggestion(args())).not.toHaveProperty("noShowTier");
  });
});

describe("result kinds and tiers", () => {
  test.each(["paid", "promised", "call_back", "lost"] as const)(
    "%s reaches each supported tier",
    (kind) => {
      const mapped = kind === "promised" ? "paid" : kind;
      const evidence = result(kind);
      const ready = deriveSuggestion(
        args({ result: evidence, reading: reading(mapped) }),
      );
      // The run keeps the fixed label key; the card gets its display text.
      expect(ready).toMatchObject({
        kind,
        tier: "ready",
        values: evidence.values,
        notes: [],
        quotes: evidence.quotes.map((found) => ({
          ...found,
          label: "Agreement",
        })),
      });
      expect(
        deriveSuggestion(
          args({
            result: {
              ...evidence,
              quotes: [
                { ...evidence.quotes[0], label: "anything the model wrote" },
              ],
            },
            reading: reading(mapped),
          }),
        )?.quotes[0].label,
      ).toBe("From the call");
      const other = mapped === "lost" ? "paid" : "lost";
      expect(
        deriveSuggestion(args({ result: evidence, reading: reading(other) })),
      ).toMatchObject({
        kind,
        tier: "check",
        values: {},
        notes: ["models_disagree"],
      });
      expect(
        deriveSuggestion(args({ result: evidence, reading: undefined })),
      ).toMatchObject({
        kind,
        tier: "unconfirmed",
        values: {},
        notes: ["jev_missing"],
      });
    },
  );

  test("a result the code's checks stopped never says Jev didn't answer", () => {
    // Jev is asked about a result only once the code's checks pass, so here
    // its result check is absent by design while both readings came back.
    expect(
      deriveSuggestion(
        args({
          result: result("paid", {
            codeChecksPassed: false,
            failedChecks: ["later_amount"],
          }),
          reading: reading("paid", { resultCheck: undefined }),
        }),
      ),
    ).toMatchObject({
      tier: "unconfirmed",
      notes: ["later_amount", "code_checks_failed"],
    });
    // With the checks passed, a missing result check is a missing answer.
    expect(
      deriveSuggestion(
        args({ reading: reading("paid", { resultCheck: undefined }) }),
      )?.notes,
    ).toEqual(["jev_missing"]);
  });

  test("a promise maps to Jev paid, while Jev promised is not a recognized ending", () => {
    expect(
      deriveSuggestion(
        args({ result: result("promised"), reading: reading("paid") }),
      )?.tier,
    ).toBe("ready");
    expect(
      deriveSuggestion(
        args({ result: result("promised"), reading: reading("promised") }),
      )?.tier,
    ).toBe("unconfirmed");
  });

  test("no decision always has quotes but no form values", () => {
    expect(
      deriveSuggestion(args({ result: result("no_decision") })),
    ).toMatchObject({
      kind: "no_decision",
      tier: "unconfirmed",
      values: {},
      notes: ["no_decision"],
    });
  });

  test("none and missing result produce no suggestion", () => {
    expect(deriveSuggestion(args({ result: result("none") }))).toBeNull();
    expect(deriveSuggestion(args({ result: undefined }))).toBeNull();
  });

  test.each(["withSummary", "withoutSummary"] as const)(
    "ready requires %s ending at inclusive 0.80",
    (key) => {
      for (const [confidence, tier] of [
        [0.7999, "unconfirmed"],
        [0.8, "ready"],
        [0.9, "ready"],
      ] as const) {
        expect(
          deriveSuggestion(
            args({
              reading: reading("paid", {
                ending: {
                  ...pair("paid", 0.99),
                  [key]: { choice: "paid", confidence },
                },
              }),
            }),
          )?.tier,
        ).toBe(tier);
      }
    },
  );

  test.each([0.7999, 0.8, 0.9])("result check boundary %f", (resultCheck) => {
    expect(
      deriveSuggestion(args({ reading: reading("paid", { resultCheck }) }))
        ?.tier,
    ).toBe(resultCheck >= 0.8 ? "ready" : "unconfirmed");
  });

  test.each(["withSummary", "withoutSummary"] as const)(
    "a conflicting %s ending at 0.60 gives Check",
    (key) => {
      expect(
        deriveSuggestion(
          args({
            reading: reading("paid", {
              ending: {
                ...pair("paid"),
                [key]: { choice: "call_back", confidence: 0.6 },
              },
            }),
          }),
        )?.tier,
      ).toBe("check");
      expect(
        deriveSuggestion(
          args({
            reading: reading("paid", {
              ending: {
                ...pair("paid"),
                [key]: { choice: "lost", confidence: 0.5999 },
              },
            }),
          }),
        )?.tier,
      ).toBe("unconfirmed");
    },
  );

  test.each(["withSummary", "withoutSummary"] as const)(
    "a %s attendance no-show at 0.60 gives Check",
    (key) => {
      expect(
        deriveSuggestion(
          args({
            reading: reading("paid", {
              attendance: {
                ...pair("held"),
                [key]: { choice: "no_show", confidence: 0.6 },
              },
            }),
          }),
        )?.tier,
      ).toBe("check");
      expect(
        deriveSuggestion(
          args({
            reading: reading("paid", {
              attendance: {
                ...pair("held"),
                [key]: { choice: "no_show", confidence: 0.5999 },
              },
            }),
          }),
        )?.tier,
      ).toBe("unconfirmed");
    },
  );

  test("ready requires both held attendance choices, without an attendance confidence cutoff", () => {
    expect(
      deriveSuggestion(
        args({
          reading: reading("paid", {
            attendance: {
              withSummary: { choice: "held" },
              withoutSummary: { choice: "held", confidence: 0.1 },
            },
          }),
        }),
      )?.tier,
    ).toBe("ready");
    expect(
      deriveSuggestion(
        args({
          reading: reading("paid", {
            attendance: { withSummary: { choice: "held" } },
          }),
        }),
      )?.tier,
    ).toBe("unconfirmed");
    expect(
      deriveSuggestion(
        args({
          reading: reading("paid", { attendance: pair("not_sales_call") }),
        }),
      )?.tier,
    ).toBe("unconfirmed");
  });

  test.each([
    { ending: undefined },
    { attendance: undefined },
    { resultCheck: undefined },
    {
      ending: {
        withSummary: { choice: "paid" },
        withoutSummary: { choice: "paid" },
      },
    },
  ] satisfies Partial<EarlyReading>[])(
    "missing required Jev answers prevent values: %j",
    (missing) => {
      expect(
        deriveSuggestion(args({ reading: reading("paid", missing) })),
      ).toMatchObject({
        tier: "unconfirmed",
        values: {},
        notes: ["jev_missing"],
      });
    },
  );

  test("failed code checks prevent Ready and carry fixed reason codes", () => {
    expect(
      deriveSuggestion(
        args({
          result: result("paid", {
            codeChecksPassed: false,
            failedChecks: ["later_amount"],
          }),
        }),
      ),
    ).toMatchObject({
      tier: "unconfirmed",
      values: {},
      notes: ["later_amount", "code_checks_failed"],
    });
  });

  test("a contradiction wins over failed code checks", () => {
    expect(
      deriveSuggestion(
        args({
          result: result("paid", { codeChecksPassed: false }),
          reading: reading("lost"),
        }),
      )?.tier,
    ).toBe("check");
  });

  test("Jev undecided is Unconfirmed rather than a conflicting actionable result", () => {
    expect(
      deriveSuggestion(args({ reading: reading("undecided") })),
    ).toMatchObject({
      tier: "unconfirmed",
      values: {},
      notes: ["jev_low_confidence"],
    });
  });

  test("display readings are short choices and confidence numbers", () => {
    expect(deriveSuggestion(args())).toMatchObject({
      claudeReading: "payment",
      jevReading: "paid 0.80",
    });
    expect(
      deriveSuggestion(
        args({
          noShow: { tier: "check", notes: [] },
          attendance: attendance(),
          reading: reading("paid", {
            attendance: {
              withSummary: { choice: "held", confidence: 0.72 },
              withoutSummary: { choice: "no_show", confidence: 0.85 },
            },
          }),
        }),
      ),
    ).toMatchObject({
      claudeReading: "absent",
      jevReading: "held 0.72 / no_show 0.85",
    });
  });

  test("all non-ready outputs have empty values even when evidence contains money", () => {
    for (const tier of [
      "empty",
      "check",
      "unconfirmed",
    ] satisfies NoShowTier[]) {
      expect(
        deriveSuggestion(args({ noShow: { tier, notes: [] } }))?.values,
      ).toEqual({});
    }
    expect(deriveSuggestion(args({ reading: undefined }))?.values).toEqual({});
    expect(
      deriveSuggestion(args({ reading: reading("lost") }))?.values,
    ).toEqual({});
  });

  test("does not mutate evidence or share mutable values, notes, or quote objects", () => {
    const input = args();
    const before = structuredClone(input);
    const actual = deriveSuggestion(input);
    if (!actual) throw new Error("Expected synthetic suggestion");
    actual.values.amountMinor = 1;
    actual.quotes[0].label = "Changed";
    actual.notes.push("changed");
    expect(input).toEqual(before);
  });
});
