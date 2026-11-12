import { anyApi, type ApiFromModules } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  evalHarness,
  addCall,
  createCase,
} from "../../../tests/callInsights/synthetic/evalHarness";
import {
  gatewayFetch,
  PAID_EXTRACTION,
} from "../../../tests/callInsightsHarness";
import type { Candidate } from "./judgePrompt";
import * as regressionModule from "./regression";
import { matchToLabels } from "./regression";
import { candidatesFromRun } from "./judge";
import { measureAttendance } from "../noShow/measures";
const api = (
  anyApi as unknown as ApiFromModules<{
    "callInsights/eval/regression": typeof regressionModule;
  }>
).callInsights.eval.regression;
vi.mock("convex/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/server")>()),
  getServiceToken: vi.fn(async () => "test-token"),
}));
vi.mock("../../auth", () => ({ authKit: { registerRoutes: () => {} } }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T18:00:00Z"));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const income: Candidate = {
  key: "income:0",
  itemClass: "income",
  category: "personal_income",
  lineStart: 4,
  minMinor: 600000,
  maxMinor: 600000,
  currency: "USD",
  period: "month",
  scenario: "current",
};
const objection: Candidate = {
  key: "objection:0",
  itemClass: "objection",
  category: "price",
  lineStart: 12,
  resolution: "unresolved",
};
function label(
  n: number,
  c: Candidate,
  patch: Partial<Doc<"callInsightEvalLabels">> = {},
): Doc<"callInsightEvalLabels"> {
  return {
    ...c,
    _id: `label-${n}` as Id<"callInsightEvalLabels">,
    _creationTime: 0,
    tenantId: "tenant" as Id<"tenants">,
    caseId: "case" as Id<"callInsightEvalCases">,
    source: "extractor",
    itemKey: c.key,
    adminVerdict: "right",
    labelRevision: 1,
    createdAt: 0,
    ...patch,
  };
}
describe("candidate result projection", () => {
  it("uses the same no-show result and tier as serving publication", () => {
    const measures = measureAttendance({
      lines: [],
      scheduledAt: 0,
      scheduledEndAt: 600000,
      recordingStartAt: 0,
      recordingEndAt: 600000,
      recorderIsAssignedCloser: true,
      matchStrong: true,
      otherRecordings: [],
      traceCoversWindow: true,
      newerBooking: false,
      inviteeEmails: [],
    });
    const candidates = candidatesFromRun({ measures, finishedAt: Date.now() });
    expect(candidates.find((c) => c.itemClass === "result")).toMatchObject({
      resultKind: "empty_recording",
      resultTier: "unconfirmed",
      noShowTier: "empty",
    });
    expect(
      candidates.find((c) => c.itemClass === "attendance")?.noShowTier,
    ).toBe("empty");
  });
  it("does not compare unready result values against values the serving suggestion never carried", () => {
    const candidates = candidatesFromRun({
      result: {
        kind: "paid",
        quotes: [],
        values: { amountMinor: 170000, currency: "USD" },
        codeChecksPassed: false,
        failedChecks: ["no_quotes"],
      },
    });
    expect(candidates.find((c) => c.itemClass === "result")).toMatchObject({
      resultKind: "paid",
      resultTier: "unconfirmed",
      resultValues: {},
    });
  });
});
describe("value matching", () => {
  it("classifies matched, missing, changed and new", () => {
    const result = matchToLabels(
      [
        { ...income, minMinor: 700000 },
        { ...objection, lineStart: 14 },
        { ...objection, key: "new", category: "partner" },
      ],
      [
        label(1, income),
        label(2, objection),
        label(
          3,
          {
            key: "goal",
            itemClass: "goal",
            category: "revenue_growth",
            lineStart: 50,
          },
          { source: "admin" },
        ),
      ],
    );
    expect(result.matched.map((m) => m.label._id)).toEqual(["label-2"]);
    expect(result.changed[0]).toMatchObject({
      label: { _id: "label-1" },
      wrongFields: ["minMinor"],
    });
    expect(result.missing.map((l) => l._id)).toEqual(["label-3"]);
    expect(result.new.map((c) => c.key)).toEqual(["new"]);
  });
  it("matches nearest spans first and uses each label once", () => {
    const result = matchToLabels(
      [
        { ...income, key: "near", lineStart: 5 },
        { ...income, key: "exact", lineStart: 4 },
        { ...income, key: "far", lineStart: 7 },
      ],
      [label(1, income)],
    );
    expect(result.matched[0].candidate.key).toBe("exact");
    expect(result.new.map((c) => c.key)).toEqual(["near", "far"]);
  });
  it("does not reuse a candidate, or double-count an admin item linked to an extractor label", () => {
    const original = label(1, income);
    const admin = label(2, income, {
      source: "admin",
      matchedLabelId: original._id,
    });
    const result = matchToLabels([income], [original, admin, label(3, income)]);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].label._id).toBe(admin._id);
    expect(result.missing.map((l) => l._id)).toEqual(["label-3"]);
  });
  it("detects changed currency, period, scenario, resolution and result kind or amount", () => {
    const result: Candidate = {
      key: "result",
      itemClass: "result",
      resultKind: "promised",
      resultValues: { amountMinor: 170000, currency: "USD" },
    };
    const output = matchToLabels(
      [
        { ...income, currency: "CAD", period: "year", scenario: "target" },
        { ...objection, resolution: "resolved" },
        {
          ...result,
          resultKind: "paid",
          resultValues: { amountMinor: 1700000, currency: "USD" },
        },
      ],
      [label(1, income), label(2, objection), label(3, result)],
    );
    expect(output.changed.map((c) => c.wrongFields)).toEqual([
      ["scenario", "period", "currency"],
      ["resolution"],
      ["resultKind", "amountMinor"],
    ]);
  });
  it("does not count an absent wrong label as a recall miss", () => {
    expect(
      matchToLabels([], [label(1, income, { adminVerdict: "wrong" })]).missing,
    ).toEqual([]);
  });
});
describe("regression jobs", () => {
  it("re-extracts without publishing and fails objection recall when every objection disappears", async () => {
    const f = await evalHarness({
      settings: { monthlyCapUsd: 100, evalMonthlyUsd: 25 },
    });
    for (let i = 1; i <= 14; i++) await addCall(f, i);
    const { campaign } = await createCase(f);
    await f.t.run(async (ctx) => {
      const rows = await ctx.db.query("callInsightEvalCases").take(100);
      for (const row of rows) {
        await ctx.db.patch("callInsightEvalCases", row._id, {
          status: "labels_committed",
          listCommittedAt: Date.now(),
          labelsCommittedAt: Date.now(),
          labelRevision: 1,
        });
        for (const [i, category] of ["partner", "price"].entries())
          await ctx.db.insert("callInsightEvalLabels", {
            tenantId: f.tenantId,
            caseId: row._id,
            source: "admin",
            itemClass: "objection",
            category,
            lineStart: 3 + i,
            lineEnd: 3 + i,
            resolution: "unresolved",
            adminVerdict: "right",
            labelRevision: 1,
            createdAt: Date.now(),
          });
      }
    });
    const before = await f.t.run((ctx) =>
      ctx.db.query("callInsightFacts").take(100),
    );
    const gateway = gatewayFetch({
      extraction: { ...PAID_EXTRACTION, items: [] },
    });
    vi.stubGlobal("fetch", vi.fn(gateway.fetchImpl));
    const jobId = await f.owner.mutation(api.startRegression, {
      campaign,
      candidate: { itemCheck: false },
    });
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    const job = await f.t.run((ctx) => ctx.db.get("callInsightJobs", jobId!));
    expect(job).toMatchObject({ status: "done", done: 15, failed: 0 });
    const report = await f.t.run((ctx) =>
      ctx.db.query("callInsightEvalReports").first(),
    );
    expect(
      report?.bars.find((b) => b.key === "objection_recall"),
    ).toMatchObject({ n: 30, wrong: 30, calls: 15, result: "fail" });
    expect(
      await f.t.run((ctx) => ctx.db.query("callInsightFacts").take(100)),
    ).toEqual(before);
    const candidates = await f.t.run((ctx) =>
      ctx.db
        .query("callInsightRuns")
        .withIndex("by_jobId", (q) => q.eq("jobId", jobId!))
        .take(100),
    );
    expect(candidates).toHaveLength(15);
    expect(
      candidates.every(
        (r) =>
          r.purpose === "eval" &&
          r.evalRole === "candidate" &&
          r.generation === 0 &&
          r.status === "answered",
      ),
    ).toBe(true);
    const detail = await f.owner.query(api.regressionDetail, {
      reportId: report!._id,
    });
    expect(detail).toHaveLength(15);
    expect(detail.every((c) => c.missing.length === 2)).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("quote");
    expect(await f.t.mutation(api.buildReport, { jobId: jobId! })).toBe(
      report!._id,
    );
    expect(gateway.calls.messages).toBe(15);
  });
  it("fails closed on changed or missing money even below report floors", async () => {
    const f = await evalHarness();
    const { campaign, caseId } = await createCase(f);
    await f.t.run(async (ctx) => {
      await ctx.db.patch("callInsightEvalCases", caseId, {
        status: "labels_committed",
        labelRevision: 1,
      });
      await ctx.db.insert("callInsightEvalLabels", {
        tenantId: f.tenantId,
        caseId,
        source: "extractor",
        itemClass: "income",
        category: "personal_income",
        lineStart: 2,
        lineEnd: 2,
        minMinor: 600000,
        currency: "USD",
        scenario: "current",
        period: "month",
        adminVerdict: "right",
        labelRevision: 1,
        createdAt: Date.now(),
      });
    });
    const gateway = gatewayFetch({
      extraction: { ...PAID_EXTRACTION, items: [] },
    });
    vi.stubGlobal("fetch", vi.fn(gateway.fetchImpl));
    await f.owner.mutation(api.startRegression, { campaign, candidate: {} });
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    const report = await f.t.run((ctx) =>
      ctx.db.query("callInsightEvalReports").first(),
    );
    expect(
      report?.bars.find((b) => b.key === "regression_money_review"),
    ).toMatchObject({ n: 1, wrong: 1, result: "fail" });
    expect(
      report?.bars
        .filter((b) => b.key !== "regression_money_review")
        .every((b) => b.result === "inconclusive"),
    ).toBe(true);
  });
  it("rejects unavailable prompt versions and unauthorized starts", async () => {
    const f = await evalHarness();
    const { campaign } = await createCase(f);
    await expect(
      f.closer.mutation(api.startRegression, { campaign, candidate: {} }),
    ).rejects.toThrow();
    await expect(
      f.owner.mutation(api.startRegression, {
        campaign,
        candidate: { promptVersion: "not-installed" },
      }),
    ).rejects.toThrow();
  });
});
