import { readFileSync } from "node:fs";
import { anyApi, type ApiFromModules } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evalHarness,
  addCall,
} from "../../../tests/callInsights/synthetic/evalHarness";
import * as driftModule from "./drift";
import { isoWeek, selectDrift } from "./drift";
import { seedFor } from "./judgePrompt";
const api = (
  anyApi as unknown as ApiFromModules<{
    "callInsights/eval/drift": typeof driftModule;
  }>
).callInsights.eval.drift;
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
describe("weekly drift", () => {
  it("chooses reproducibly with separate non-overlapping random and risk samples", () => {
    const calls = Array.from({ length: 12 }, (_, id) => ({
      id,
      risk: id % 2 === 0,
    }));
    const one = selectDrift(calls, "2026-W45"),
      two = selectDrift(calls, "2026-W45");
    expect(one).toEqual(two);
    expect(one.random).toHaveLength(3);
    expect(one.risk).toHaveLength(2);
    expect(one.risk.every((c) => c.risk && !one.random.includes(c))).toBe(true);
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe("2026-W53");
    expect(isoWeek(Date.UTC(2026, 10, 3))).toBe("2026-W45");
  });
  it("creates five cases and a judge job once for an enabled tenant", async () => {
    const f = await evalHarness();
    for (let i = 1; i <= 8; i++) await addCall(f, i);
    await f.t.run(async (ctx) => {
      const headers = await ctx.db.query("callInsightFacts").take(100);
      for (const h of headers)
        if (h.kind === "call")
          await ctx.db.patch("callInsightFacts", h._id, {
            analyzedAt: Date.now(),
            noShowTier: "review",
          });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rejected", { status: 400 })),
    );
    await f.t.mutation(api.weekly, {});
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    const cases = await f.t.run((ctx) =>
      ctx.db.query("callInsightEvalCases").take(100),
    );
    expect(cases).toHaveLength(5);
    expect(cases.filter((c) => c.split === "drift_random")).toHaveLength(3);
    expect(cases.filter((c) => c.split === "drift_risk")).toHaveLength(2);
    expect(
      cases.every(
        (c) =>
          c.campaign === "drift-2026-W45" &&
          c.status === "to_read" &&
          c.candidateRunId &&
          c.purgeAt > Date.now(),
      ),
    ).toBe(true);
    const jobs = await f.t.run((ctx) =>
      ctx.db.query("callInsightJobs").take(10),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "eval_judge", total: 5 });
    await f.t.mutation(api.weekly, {});
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await f.t.run((ctx) => ctx.db.query("callInsightEvalCases").take(100)),
    ).toHaveLength(5);
    expect(
      readFileSync(new URL("../../crons.ts", import.meta.url), "utf8"),
    ).toContain('crons.cron("call-insights-drift", "17 8 * * 1"');
  });
  it("samples across call pages, rather than stopping at a recent-call cap", async () => {
    const f = await evalHarness();
    for (let i = 1; i <= 64; i++) await addCall(f, i);
    const headers = await f.t.run(async (ctx) => {
      const headers = await ctx.db.query("callInsightFacts").take(100);
      for (const h of headers)
        if (h.kind === "call")
          await ctx.db.patch("callInsightFacts", h._id, {
            analyzedAt: Date.now(),
            noShowTier: "review",
          });
      return headers;
    });
    const ranked = headers
      .map((h) => ({
        recordingId: h.recordingId,
        rank: seedFor(`${f.tenantId}:2026-W45:${h.recordingId}`),
      }))
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          String(a.recordingId).localeCompare(String(b.recordingId)),
      );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rejected", { status: 400 })),
    );
    await f.t.mutation(api.weekly, {});
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    const cases = await f.t.run((ctx) =>
      ctx.db.query("callInsightEvalCases").take(10),
    );
    expect(new Set(cases.map((c) => c.recordingId))).toEqual(
      new Set(ranked.slice(0, 5).map((c) => c.recordingId)),
    );
    expect(
      cases.filter((c) => c.split === "drift_random").map((c) => c.recordingId),
    ).toEqual(ranked.slice(0, 3).map((c) => c.recordingId));
  });
  it("writes nothing and schedules no model while off, including absent settings", async () => {
    const f = await evalHarness();
    await f.t.run((ctx) =>
      ctx.db.patch("tenants", f.tenantId, { callInsights: undefined }),
    );
    const fetch = vi.fn(() => {
      throw new Error("Network is forbidden");
    });
    vi.stubGlobal("fetch", fetch);
    await f.t.mutation(api.weekly, {});
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await f.t.run((ctx) => ctx.db.query("callInsightEvalCases").take(10)),
    ).toHaveLength(0);
    expect(
      await f.t.run((ctx) => ctx.db.query("callInsightJobs").take(10)),
    ).toHaveLength(0);
    expect(
      await f.t.run((ctx) => ctx.db.query("callInsightBudgets").take(10)),
    ).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
