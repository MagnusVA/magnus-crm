import { describe, expect, it } from "vitest";
import { callDecisions } from "../secondOpinion/jev";
import { buildQuestionGroups } from "../secondOpinion/questions";
import { buildState } from "../secondOpinion/transcript";
import {
  buildReadingRequests,
  buildResultCheck,
  combineReadingAnswers,
} from "./earlyReading";
import type { PreparedLine } from "./transcriptPrep";
import type { ResultEvidence } from "./validators";

const lines: PreparedLine[] = Array.from({ length: 20 }, (_, i) => ({
  index: i + 1,
  atSeconds: i * 30,
  at: `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`,
  role: "Prospect",
  speakerKey: "prospect",
  isCloserKey: false,
  text: `Transcript line ${i + 1}`,
}));
const input = {
  kind: "full" as const,
  callKind: "new call" as const,
  program: "Program",
  recordedMinutes: 10,
  summary: "PRIVATE_FATHOM_SUMMARY",
  actionItems: ["PRIVATE_ACTION_ITEM"],
  lines,
};
const result: ResultEvidence = {
  kind: "paid",
  codeChecksPassed: true,
  failedChecks: [],
  values: { amountMinor: 170000, currency: "USD" },
  quotes: [
    {
      label: "MODEL_LABEL",
      quote: "MODEL_QUOTE",
      lineIndex: 5,
      atSeconds: 120,
      speaker: "Prospect",
    },
  ],
};

describe("buildReadingRequests", () => {
  it("builds four full reading requests using Second opinion's exact groups", () => {
    const requests = buildReadingRequests(input);
    expect(requests.map(({ key }) => key)).toEqual([
      "attendance:with",
      "attendance:without",
      "ending:with",
      "ending:without",
    ]);
    const groups = buildQuestionGroups(undefined);
    for (const { key, request } of requests) {
      expect(request.model).toBe("typesafe/jev-1.13");
      expect(request.provider).toEqual({ zdr: true, data_collection: "deny" });
      const group = groups.find(
        ({ group }) =>
          group === (key.startsWith("attendance") ? "attendance" : "outcome"),
      );
      expect(request.questions).toEqual(group?.questions);
      expect(request.state).toEqual(
        buildState({ ...input, withSummary: key.endsWith(":with") }),
      );
      expect(request.questions).not.toHaveProperty("claim");
      expect(JSON.stringify(request.questions)).not.toContain(input.summary);
    }
    expect(Object.keys(requests[2].request.questions)).toEqual([
      "ending",
      "objection",
    ]);
  });

  it("builds only two attendance requests for attendance_only", () => {
    const requests = buildReadingRequests({
      ...input,
      kind: "attendance_only",
    });
    expect(requests.map(({ key }) => key)).toEqual([
      "attendance:with",
      "attendance:without",
    ]);
    for (const { request } of requests)
      expect(Object.keys(request.questions)).toEqual(["attendance"]);
  });

  it("includes summary and action items only in the with reading", () => {
    const [withSummary, withoutSummary] = buildReadingRequests(input);
    expect(withSummary.request.state).toHaveProperty(
      "fathomSummary",
      input.summary,
    );
    expect(withSummary.request.state).toHaveProperty(
      "actionItems",
      input.actionItems,
    );
    expect(withoutSummary.request.state).not.toHaveProperty("fathomSummary");
    expect(withoutSummary.request.state).not.toHaveProperty("actionItems");
    expect(JSON.stringify(withoutSummary.request.state)).not.toContain(
      input.summary,
    );
  });
});

describe("combineReadingAnswers", () => {
  it("keeps the two readings separate and uses confidenceOf including probability fallback", async () => {
    const parsed = await Promise.all(
      buildReadingRequests(input).map(async ({ key, request }) => {
        const answers = key.startsWith("attendance")
          ? { attendance: { choice: "held", probabilities: { held: 0.91 } } }
          : {
              ending: { choice: "paid", confidence: 0.87 },
              objection: { choice: "none" },
            };
        const response = await callDecisions(
          request,
          async () => "fake-token",
          async () => new Response(JSON.stringify({ answers, usage: {} })),
        );
        if (response.kind !== "ok")
          throw new Error("Fake Decisions response failed");
        return { key, answers: response.parsed.answers };
      }),
    );
    expect(combineReadingAnswers(parsed, false)).toEqual({
      attendance: {
        withSummary: { choice: "held", confidence: 0.91 },
        withoutSummary: { choice: "held", confidence: 0.91 },
      },
      ending: {
        withSummary: { choice: "paid", confidence: 0.87 },
        withoutSummary: { choice: "paid", confidence: 0.87 },
      },
      incomplete: false,
    });
  });

  it("marks a missing reading incomplete and keeps the answer that arrived", () => {
    expect(
      combineReadingAnswers(
        [
          {
            key: "attendance:with",
            answers: { attendance: { choice: "held", confidence: 0.9 } },
          },
        ],
        false,
      ),
    ).toEqual({
      attendance: { withSummary: { choice: "held", confidence: 0.9 } },
      incomplete: true,
    });
    expect(
      combineReadingAnswers(
        [
          {
            key: "attendance:with",
            answers: { attendance: { choice: "held" } },
          },
          {
            key: "attendance:without",
            answers: { attendance: { choice: "held" } },
          },
          { key: "ending:with", answers: { ending: { choice: "lost" } } },
        ],
        false,
      ),
    ).toMatchObject({
      incomplete: true,
      ending: { withSummary: { choice: "lost", confidence: 0 } },
    });
  });

  it("treats a missing answer in an existing request as incomplete", () => {
    expect(
      combineReadingAnswers([{ key: "attendance:with", answers: {} }], false),
    ).toEqual({ incomplete: true });
    expect(combineReadingAnswers([], false)).toEqual({ incomplete: true });
  });

  it("does not require ending answers for attendance_only and preserves explicit incompleteness", () => {
    const parsed = ["with", "without"].map((suffix) => ({
      key: `attendance:${suffix}`,
      answers: { attendance: { choice: "no_show", confidence: 0.96 } },
    }));
    expect(combineReadingAnswers(parsed, false)).toEqual({
      attendance: {
        withSummary: { choice: "no_show", confidence: 0.96 },
        withoutSummary: { choice: "no_show", confidence: 0.96 },
      },
      incomplete: false,
    });
    expect(combineReadingAnswers(parsed, true).incomplete).toBe(true);
  });
});

describe("buildResultCheck", () => {
  it.each([
    ["paid", "The prospect agreed to pay 1,700 USD on this call."],
    ["promised", "The prospect promised to pay later, not on this call."],
    ["call_back", "The prospect asked to be contacted again at a later time."],
    ["lost", "The prospect declined to buy."],
  ] as const)(
    "builds the fixed %s statement without model text",
    (kind, instructions) => {
      const request = buildResultCheck({ ...result, kind }, lines);
      expect(request?.questions).toEqual({
        result: { type: "noul", instructions },
      });
      expect(JSON.stringify(request)).not.toContain("MODEL_QUOTE");
      expect(JSON.stringify(request)).not.toContain("MODEL_LABEL");
    },
  );

  it.each([
    [
      { amountMinor: 123456, currency: "CAD" },
      "The prospect agreed to pay 1,234.56 CAD on this call.",
    ],
    [{ amountMinor: 170000 }, "The prospect agreed to pay 1,700 on this call."],
    [{ currency: "USD" }, "The prospect agreed to pay USD on this call."],
    [{}, "The prospect agreed to pay on this call."],
    [
      { amountMinor: 0, currency: "USD" },
      "The prospect agreed to pay 0 USD on this call.",
    ],
  ])(
    "omits absent payment fields and renders major units: %j",
    (values, instructions) => {
      expect(
        buildResultCheck({ ...result, values }, lines)?.questions.result
          .instructions,
      ).toBe(instructions);
    },
  );

  it("unions quote context in order and deduplicates overlapping windows", () => {
    const request = buildResultCheck(
      {
        ...result,
        quotes: [
          { ...result.quotes[0], lineIndex: 15 },
          result.quotes[0],
          { ...result.quotes[0], lineIndex: 7 },
        ],
      },
      lines,
    );
    const expected = lines.filter(({ index }) =>
      [5, 7, 15].some((center) => Math.abs(index - center) <= 3),
    );
    expect(request?.state).toBe(
      expected
        .map((line) => `#${line.index} [${line.at}] P: ${line.text}`)
        .join("\n"),
    );
  });

  it.each([
    "paid",
    "promised",
    "call_back",
    "lost",
    "none",
    "no_decision",
  ] as const)("returns null for failed code checks on %s", (kind) => {
    expect(
      buildResultCheck({ ...result, kind, codeChecksPassed: false }, lines),
    ).toBeNull();
  });

  it.each(["none", "no_decision"] as const)(
    "returns null for %s even if code checks passed",
    (kind) => {
      expect(buildResultCheck({ ...result, kind }, lines)).toBeNull();
    },
  );
});
