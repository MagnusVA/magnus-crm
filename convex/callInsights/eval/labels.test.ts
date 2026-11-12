import { describe, expect, it } from "vitest";
import {
  api,
  evalHarness,
  createCase,
  committedCase,
  foreignAdmin,
} from "../../../tests/callInsights/synthetic/evalHarness";
import { autoMatch } from "./labels";

describe("two-phase grading", () => {
  it("requires a blind result and attendance, then every grade, and commits revisions once", async () => {
    const f = await evalHarness();
    const c = await createCase(f);
    await expect(
      f.owner.mutation(api.labels.commitLabels, { caseId: c.caseId }),
    ).rejects.toThrow();
    await expect(
      f.owner.mutation(api.labels.commitList, { caseId: c.caseId }),
    ).rejects.toThrow();
    const labelId = await f.owner.mutation(api.labels.addAdminItem, {
      caseId: c.caseId,
      itemClass: "objection",
      category: "partner",
      lineStart: 3,
      lineEnd: 3,
    });
    await f.owner.mutation(api.labels.setAdminResult, {
      caseId: c.caseId,
      resultKind: "paid",
      resultValues: {
        amountMinor: 170000,
        currency: "USD",
        currencyAssumed: true,
      },
      noShowHeld: true,
    });
    await expect(
      f.owner.mutation(api.labels.commitList, {
        caseId: c.caseId,
        skipped: true,
      }),
    ).rejects.toThrow();
    await f.owner.mutation(api.labels.commitList, { caseId: c.caseId });
    await expect(
      f.owner.mutation(api.labels.addAdminItem, {
        caseId: c.caseId,
        itemClass: "objection",
        category: "partner",
        lineStart: 3,
        lineEnd: 3,
      }),
    ).rejects.toThrow();
    await expect(
      f.owner.mutation(api.labels.removeAdminItem, { labelId }),
    ).rejects.toThrow();
    await expect(
      f.owner.mutation(api.labels.setAdminResult, {
        caseId: c.caseId,
        resultKind: "lost",
        noShowHeld: true,
      }),
    ).rejects.toThrow();
    await expect(
      f.owner.mutation(api.labels.commitLabels, { caseId: c.caseId }),
    ).rejects.toThrow();
    const view = await f.owner.query(api.cases.caseForGrading, {
      caseId: c.caseId,
    });
    expect(view.candidates).toHaveLength(3);
    expect(view.suggestion?.kind).toBe("paid");
    await f.owner.mutation(api.labels.matchAdminItem, {
      labelId,
      matchedLabelId: view.candidates![0].labelId,
    });
    for (const candidate of view.candidates!)
      await f.owner.mutation(api.labels.gradeItem, {
        labelId: candidate.labelId,
        verdict: "right",
      });
    await f.owner.mutation(api.labels.commitLabels, { caseId: c.caseId });
    expect(
      await f.owner.query(api.cases.caseForGrading, { caseId: c.caseId }),
    ).toMatchObject({
      phase: "done",
      case: { labelRevision: 1, listSkipped: false },
    });
    await expect(
      f.owner.mutation(api.labels.commitLabels, { caseId: c.caseId }),
    ).rejects.toThrow();
    await f.owner.mutation(api.labels.reopenCase, { caseId: c.caseId });
    await f.owner.mutation(api.labels.commitLabels, { caseId: c.caseId });
    expect(
      (await f.owner.query(api.cases.caseForGrading, { caseId: c.caseId })).case
        .labelRevision,
    ).toBe(2);
  });
  it("supports deletion, skipped lists, unsure grades and an explicit unmatched item", async () => {
    const f = await evalHarness();
    const c = await createCase(f);
    const id = await f.admin.mutation(api.labels.addAdminItem, {
      caseId: c.caseId,
      itemClass: "income",
      category: "personal_income",
      lineStart: 2,
      lineEnd: 2,
      minMinor: 100,
      currency: "USD",
    });
    await f.admin.mutation(api.labels.removeAdminItem, { labelId: id });
    await f.admin.mutation(api.labels.commitList, {
      caseId: c.caseId,
      skipped: true,
    });
    const view = await f.admin.query(api.cases.caseForGrading, {
      caseId: c.caseId,
    });
    expect(view.case.listSkipped).toBe(true);
    for (const label of view.candidates!)
      await f.admin.mutation(api.labels.gradeItem, {
        labelId: label.labelId,
        verdict: "unsure",
      });
    await f.admin.mutation(api.labels.commitLabels, { caseId: c.caseId });
    expect(
      (await f.t.run((ctx) => ctx.db.get("callInsightEvalCases", c.caseId)))
        ?.labelledByUserId,
    ).toBe(f.adminId);
  });
  it("checks tenant, source, line ranges, categories, money and fixed field names", async () => {
    const f = await evalHarness();
    const c = await createCase(f);
    const other = await foreignAdmin(f);
    const args = {
      caseId: c.caseId,
      itemClass: "objection" as const,
      category: "partner",
      lineStart: 3,
      lineEnd: 3,
    };
    for (const patch of [
      { category: "free text" },
      { lineStart: 0 },
      { lineEnd: 999 },
      { minMinor: 1.5 },
      { currency: "words" },
    ])
      await expect(
        f.owner.mutation(api.labels.addAdminItem, { ...args, ...patch }),
      ).rejects.toThrow();
    await expect(
      other.mutation(api.labels.addAdminItem, args),
    ).rejects.toThrow();
    await expect(
      f.closer.mutation(api.labels.addAdminItem, args),
    ).rejects.toThrow();
    const id = await f.owner.mutation(api.labels.addAdminItem, args);
    await expect(
      other.mutation(api.labels.removeAdminItem, { labelId: id }),
    ).rejects.toThrow();
    await expect(
      f.owner.mutation(api.labels.gradeItem, { labelId: id, verdict: "right" }),
    ).rejects.toThrow();
    await f.owner.mutation(api.labels.setAdminResult, {
      caseId: c.caseId,
      resultKind: "lost",
      noShowHeld: true,
    });
    await f.owner.mutation(api.labels.commitList, { caseId: c.caseId });
    await expect(
      f.owner.mutation(api.labels.gradeItem, { labelId: id, verdict: "right" }),
    ).rejects.toThrow();
    const view = await f.owner.query(api.cases.caseForGrading, {
      caseId: c.caseId,
    });
    await expect(
      f.owner.mutation(api.labels.gradeItem, {
        labelId: view.candidates![0].labelId,
        verdict: "wrong",
        wrongFields: ["prospect words"],
      }),
    ).rejects.toThrow();
    await f.owner.mutation(api.labels.matchAdminItem, {
      labelId: id,
      matchedLabelId: null,
    });
    await expect(
      f.owner.mutation(api.labels.matchAdminItem, {
        labelId: id,
        matchedLabelId: view.candidates![1].labelId,
      }),
    ).rejects.toThrow();
    await expect(
      other.mutation(api.labels.gradeItem, {
        labelId: view.candidates![0].labelId,
        verdict: "right",
      }),
    ).rejects.toThrow();
  });
  it("clears prior judge verdicts when labels are recommitted", async () => {
    const f = await evalHarness();
    const c = await committedCase(f);
    await f.t.run((ctx) =>
      ctx.db.patch("callInsightEvalLabels", c.labels[0]._id, {
        judgeVerdict: "supported",
      }),
    );
    await f.owner.mutation(api.labels.reopenCase, { caseId: c.caseId });
    await f.owner.mutation(api.labels.commitLabels, { caseId: c.caseId });
    expect(
      (await f.owner.query(api.cases.caseForGrading, { caseId: c.caseId }))
        .judge,
    ).toEqual([]);
  });
});
describe("nearest one-to-one automatic matching", () => {
  it("matches class, category and overlapping spans with a two-line margin", () => {
    const item = (
      labelId: string,
      lineStart: number,
      category = "price",
      itemClass = "objection",
      lineEnd = lineStart,
    ) => ({ labelId, lineStart, lineEnd, category, itemClass });
    expect(
      autoMatch(
        [item("a", 10), item("b", 11), item("c", 30), item("d", 50, "partner")],
        [
          item("x", 11),
          item("y", 8),
          item("z", 32, "price", "income"),
          item("w", 48, "partner"),
        ],
      ),
    ).toEqual([
      { labelId: "a", matchedLabelId: "y" },
      { labelId: "b", matchedLabelId: "x" },
      { labelId: "c", matchedLabelId: null },
      { labelId: "d", matchedLabelId: "w" },
    ]);
    expect(
      autoMatch([item("a", 10, "price", "objection", 20)], [item("x", 22)]),
    ).toEqual([{ labelId: "a", matchedLabelId: "x" }]);
    expect(autoMatch([item("a", 10)], [item("x", 13)])).toEqual([
      { labelId: "a", matchedLabelId: null },
    ]);
  });
});
