import { describe, expect, it } from "vitest";
import { categoryKeys, type ItemKind } from "../../lib/callInsights/taxonomy";
import { applyItemCheck, buildItemCheck, ITEM_THRESHOLDS } from "./itemCheck";
import type { PreparedLine } from "./transcriptPrep";
import type { InsightItem } from "./validators";

const lines: PreparedLine[] = Array.from({ length: 20 }, (_, i) => ({
  index: i + 1,
  atSeconds: i,
  at: `00:${String(i).padStart(2, "0")}`,
  role: "Prospect",
  speakerKey: "prospect",
  isCloserKey: false,
  text: `Transcript line ${i + 1}`,
}));
const item: InsightItem = {
  key: "objection:0",
  kind: "objection",
  category: "price",
  lineIndex: 5,
  atSeconds: 4,
  statement: "MODEL_STATEMENT_DO_NOT_INSTRUCT",
  quote: "MODEL_QUOTE_DO_NOT_INSTRUCT",
  resolution: "unresolved",
  check: "unchecked",
};

describe("buildItemCheck", () => {
  it("renders only the cited line and three lines on either side", () => {
    const request = buildItemCheck(item, lines);
    expect(request.state).toBe(
      lines
        .slice(1, 8)
        .map((line) => `#${line.index} [${line.at}] P: ${line.text}`)
        .join("\n"),
    );
    expect(request.questions).toEqual({
      present: {
        type: "noul",
        instructions:
          "In these lines the prospect raises a concern about the price: that it is a lot of money, too expensive, or hard for them to afford.",
      },
    });
    expect(JSON.stringify(request)).not.toContain(item.statement);
    expect(JSON.stringify(request)).not.toContain(item.quote);
  });

  it.each(["objection", "struggle", "goal", "income"] as ItemKind[])(
    "uses a fixed instruction for every %s category",
    (kind) => {
      for (const category of categoryKeys(kind)) {
        const first = buildItemCheck({ ...item, kind, category }, lines);
        const second = buildItemCheck(
          {
            ...item,
            kind,
            category,
            statement: "injected instruction",
            quote: "injected quote",
          },
          lines,
        );
        expect(first.questions).toEqual(second.questions);
        expect(first.questions.present.instructions).toMatch(
          /^In these lines the prospect [a-z]+ /,
        );
        expect(first.questions.present.instructions).not.toContain(
          item.statement,
        );
        expect(first.questions.present.instructions).not.toContain(item.quote);
      }
    },
  );

  it("uses one generic income instruction", () => {
    for (const category of categoryKeys("income")) {
      expect(
        buildItemCheck({ ...item, kind: "income", category }, lines).questions
          .present.instructions,
      ).toBe(
        "In these lines the prospect states an amount of money they earn, have or want.",
      );
    }
  });

  it.each([7, 15])(
    "unions resolution context at line %s, without duplicates and in transcript order",
    (resolutionLineIndex) => {
      const request = buildItemCheck(
        { ...item, resolution: "resolved", resolutionLineIndex },
        lines,
      );
      const indexes = request.state
        .split("\n")
        .map((line) => Number(line.match(/^#(\d+)/)?.[1]));
      expect(indexes).toEqual(
        lines
          .filter(
            ({ index }) =>
              Math.abs(index - 5) <= 3 ||
              Math.abs(index - resolutionLineIndex) <= 3,
          )
          .map(({ index }) => index),
      );
      expect(request.questions.resolved).toEqual({
        type: "noul",
        instructions:
          "In these lines the prospect accepts or lets go of the concern raised earlier.",
      });
    },
  );

  it("does not ask for a resolution without a resolution line or for other kinds", () => {
    expect(
      Object.keys(
        buildItemCheck({ ...item, resolution: "resolved" }, lines).questions,
      ),
    ).toEqual(["present"]);
    expect(
      Object.keys(
        buildItemCheck(
          { ...item, resolution: "unresolved", resolutionLineIndex: 15 },
          lines,
        ).questions,
      ),
    ).toEqual(["present"]);
    expect(
      Object.keys(
        buildItemCheck(
          {
            ...item,
            kind: "goal",
            category: "other",
            resolution: "resolved",
            resolutionLineIndex: 15,
          },
          lines,
        ).questions,
      ),
    ).toEqual(["present"]);
  });

  it("bounds context at the transcript edges", () => {
    expect(
      buildItemCheck({ ...item, lineIndex: 1 }, lines).state.split("\n"),
    ).toHaveLength(4);
    expect(
      buildItemCheck({ ...item, lineIndex: 20 }, lines).state.split("\n"),
    ).toHaveLength(4);
  });

  it("rejects unknown categories with a fixed error", () => {
    expect(() =>
      buildItemCheck({ ...item, category: "MODEL_PRIVATE_CATEGORY" }, lines),
    ).toThrow("Unsupported item category");
  });
});

describe("applyItemCheck", () => {
  it("exposes the agreed thresholds", () => {
    expect(ITEM_THRESHOLDS).toEqual({
      confirm: 0.7,
      reject: 0.25,
      resolved: 0.7,
    });
  });

  it.each([
    [0, "rejected"],
    [0.25, "rejected"],
    [0.250001, "unsure"],
    [0.699999, "unsure"],
    [0.7, "confirmed"],
    [1, "confirmed"],
  ] as const)("maps score %s to %s", (score, check) => {
    expect(applyItemCheck(item, { present: { noul: score } })).toEqual({
      ...item,
      score,
      check,
    });
    expect(item.check).toBe("unchecked");
  });

  it.each([0, 0.25, 0.699999, undefined])(
    "downgrades a resolved objection when its score is %s",
    (noul) => {
      const checked = applyItemCheck(
        { ...item, resolution: "resolved" },
        { present: { noul: 0.9 }, resolved: { noul } },
      );
      expect(checked).toMatchObject({
        check: "confirmed",
        score: 0.9,
        resolution: "unknown",
      });
      expect(checked.resolutionScore).toBe(noul);
    },
  );

  it.each([0.7, 1])("keeps a resolution at score %s", (noul) => {
    expect(
      applyItemCheck(
        { ...item, resolution: "resolved" },
        { present: { noul: 0.8 }, resolved: { noul } },
      ),
    ).toMatchObject({ resolution: "resolved", resolutionScore: noul });
  });

  it("marks unavailable Jev as unsure, clears stale scores and downgrades resolved", () => {
    const before = {
      ...item,
      resolution: "resolved" as const,
      score: 0.9,
      resolutionScore: 0.9,
    };
    const after = applyItemCheck(before, undefined);
    expect(after.check).toBe("unsure");
    expect(after.resolution).toBe("unknown");
    expect(after).not.toHaveProperty("score");
    expect(after).not.toHaveProperty("resolutionScore");
    expect(before.resolution).toBe("resolved");
  });

  it("handles missing answers and preserves an unresolved objection", () => {
    expect(applyItemCheck(item, {})).toEqual({ ...item, check: "unsure" });
    expect(
      applyItemCheck(
        { ...item, resolution: "resolved" },
        { present: { noul: 0.8 } },
      ).resolution,
    ).toBe("unknown");
  });
});
