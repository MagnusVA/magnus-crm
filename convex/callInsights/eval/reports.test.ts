import { describe, expect, it } from "vitest";
import {
  api,
  evalHarness,
  committedCase,
  foreignAdmin,
} from "../../../tests/callInsights/synthetic/evalHarness";
import { BAR_DEFINITIONS } from "./metrics";
import { CAPABILITY_BARS } from "./reports";

describe("stored reports and capability gates", () => {
  it("stores numbers only from committed cases, newest per kind and split", async () => {
    const f = await evalHarness();
    const c = await committedCase(f);
    const reportId = await f.owner.mutation(api.reports.buildReport, {
      campaign: c.campaign,
      split: "dev",
      kind: "quality",
    });
    const row = await f.t.run((ctx) =>
      ctx.db.get("callInsightEvalReports", reportId),
    );
    expect(row).toMatchObject({
      kind: "quality",
      split: "dev",
      campaign: c.campaign,
      spentMicroUsd: 0,
      createdByUserId: f.ownerId,
    });
    expect(row!.bars).toHaveLength(6);
    expect(row!.bars.every((b) => b.result === "inconclusive")).toBe(true);
    expect(JSON.stringify(row)).not.toContain("husband");
    await f.admin.mutation(api.reports.buildReport, {
      campaign: c.campaign,
      split: "dev",
      kind: "quality",
    });
    expect(
      (await f.owner.query(api.reports.latestReports, {})).reports,
    ).toHaveLength(1);
    await f.owner.mutation(api.labels.reopenCase, { caseId: c.caseId });
    const emptyId = await f.owner.mutation(api.reports.buildReport, {
      campaign: c.campaign,
      split: "dev",
      kind: "quality",
    });
    expect(
      (await f.t.run((ctx) =>
        ctx.db.get("callInsightEvalReports", emptyId),
      ))!.bars.every((b) => b.n === 0),
    ).toBe(true);
  });
  it("requires every holdout dependency, reports failures, and ignores development passes", async () => {
    const f = await evalHarness();
    const seed = async (
      split: string,
      result: "pass" | "fail",
      badKey?: string,
    ) =>
      f.t.run(async (ctx) => {
        for (const kind of ["quality", "suggestions", "no_show"] as const)
          await ctx.db.insert("callInsightEvalReports", {
            tenantId: f.tenantId,
            kind,
            split,
            createdAt: Date.now(),
            spentMicroUsd: 0,
            bars: BAR_DEFINITIONS.filter((d) => d.kind === kind).map((d) => ({
              key: d.key,
              n: d.floor,
              wrong: d.key === badKey ? 1 : 0,
              calls: d.callFloor,
              floor: d.floor,
              rule: d.rule,
              result: d.key === badKey ? "fail" : result,
            })),
          });
      });
    await seed("dev", "pass");
    expect(
      (
        await f.owner.query(api.reports.capabilityStatus, {})
      ).capabilities.every((c) => c.result === "inconclusive"),
    ).toBe(true);
    await seed("holdout", "pass");
    const all = await f.owner.query(api.reports.capabilityStatus, {});
    expect(all.capabilities.every((c) => c.result === "pass")).toBe(true);
    expect(
      all.capabilities
        .find((c) => c.key === "amountPrefill")
        ?.bars.map((b) => b.key),
    ).toEqual([...CAPABILITY_BARS.amountPrefill]);
    await seed("holdout", "pass", "amount_prefill");
    expect(
      (await f.owner.query(api.reports.capabilityStatus, {})).capabilities.find(
        (c) => c.key === "amountPrefill",
      )?.result,
    ).toBe("fail");
  });
  it("includes F2 report kinds without letting them certify a switch", async () => {
    const f = await evalHarness();
    await f.t.run(async (ctx) => {
      for (const kind of [
        "judge_calibration",
        "regression",
        "drift",
        "wait_study",
      ] as const) {
        await ctx.db.insert("callInsightEvalReports", {
          tenantId: f.tenantId,
          kind,
          split: "holdout",
          spentMicroUsd: 0,
          createdAt: Date.now(),
          bars: BAR_DEFINITIONS.map((d) => ({
            key: d.key,
            n: d.floor,
            wrong: 0,
            calls: d.callFloor,
            floor: d.floor,
            rule: d.rule,
            result: "pass" as const,
          })),
        });
      }
    });
    expect(
      (await f.owner.query(api.reports.latestReports, {})).reports,
    ).toHaveLength(4);
    expect(
      (
        await f.owner.query(api.reports.capabilityStatus, {})
      ).capabilities.every((c) => c.result === "inconclusive"),
    ).toBe(true);
  });
  it("isolates report reads and rejects closer writes", async () => {
    const f = await evalHarness();
    const c = await committedCase(f);
    const other = await foreignAdmin(f);
    await f.owner.mutation(api.reports.buildReport, {
      campaign: c.campaign,
      split: "dev",
      kind: "quality",
    });
    expect((await other.query(api.reports.latestReports, {})).reports).toEqual(
      [],
    );
    expect(
      (await other.query(api.reports.capabilityStatus, {})).capabilities.every(
        (c) => c.result === "inconclusive",
      ),
    ).toBe(true);
    await expect(
      f.closer.mutation(api.reports.buildReport, {
        campaign: c.campaign,
        split: "dev",
        kind: "quality",
      }),
    ).rejects.toThrow();
  });
});
