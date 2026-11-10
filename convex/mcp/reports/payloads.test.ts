import { afterEach, describe, expect, it, vi } from "vitest";
import workpool from "@convex-dev/workpool/test";
import type { WorkId } from "@convex-dev/workpool";
import { adminFixture, adminCaller, seedAdminTenant } from "../../../tests/mcpAdminFixtures";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { resolveAnalyticsRange } from "../../../lib/analyticsRange";
import { failedJobRetryable, type ReportJob } from "./contracts";
import type { JobAnswer } from "./planning";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-09T18:00:00Z"));
  const f = await adminFixture();
  workpool.register(f.t, "analyticsWorkpool");
  await f.t.run((ctx) =>
    ctx.db.patch("tenants", f.tenantId, {
      businessDayAppliedVersion: 0,
      analyticsReports: ["people", "scorecard"],
    }),
  );
  const watermark = Date.now() - 3_600_000;
  await f.t.run((ctx) => ctx.db.insert("analyticsSync", { beatAt: Date.now(), watermark }));
  return { ...f, caller: adminCaller(f.orgId), watermark };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function job(f: Fixture, key = "test:people.lead_gen"): ReportJob {
  const range = { kind: "custom" as const, startDate: "2026-10-01", endDateInclusive: "2026-10-31" };
  const window = resolveAnalyticsRange(range, { timeZone: "America/Tegucigalpa", dayStartHour: 1 }, Date.now());
  return { key, report: "people.lead_gen", range, window, syncWatermark: f.watermark, filtersJson: '{"memberId":null}' };
}

/** A running request, as admission leaves it. */
async function running(f: Fixture, key?: string) {
  const j = job(f, key);
  return await f.t.run(async (ctx) => {
    const requestId = await ctx.db.insert("mcpReportRequests", {
      tenantId: f.tenantId,
      userId: f.adminId,
      key: j.key,
      report: j.report,
      kind: "job",
      paramsJson: JSON.stringify(j),
      status: "running",
      runToken: "run-1",
      workId: "work-1",
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
    return { run: { requestId, runToken: "run-1" }, job: j };
  });
}

/** A JSON answer of about `megabytes` MB, like the lead gen People panel's person ids. */
function bigAnswer(megabytes: number) {
  const ids = Array.from({ length: Math.ceil((megabytes * 1_000_000) / 35) }, (_, i) => `k57${String(i).padStart(29, "0")}`);
  return JSON.stringify({ rows: [{ personIds: ids }], partial: false });
}

async function store(f: Fixture, run: { requestId: Id<"mcpReportRequests">; runToken: string }, json: string) {
  const { splitPayload } = await import("../../analytics/results");
  const parts = splitPayload(json);
  for (const [index, part] of parts.entries())
    expect(await f.t.mutation(internal.mcp.reports.admission.storePart, { ...run, index, json: part })).toBe(true);
  return parts.length;
}

async function complete(f: Fixture, run: { requestId: Id<"mcpReportRequests">; runToken: string }) {
  await f.t.mutation(internal.mcp.reports.admission.onComplete, {
    workId: "work-1" as WorkId,
    context: run,
    result: { kind: "success", returnValue: null },
  });
}

async function partCount(f: Fixture) {
  return (await f.t.run((ctx) => ctx.db.query("mcpReportPayloads").take(100))).length;
}

describe("assistant answers in parts", () => {
  it("publishes a multi-megabyte answer and reads it back whole", async () => {
    const f = await fixture();
    const { run, job: runJob } = await running(f);
    const json = bigAnswer(2.5);
    const parts = await store(f, run, json);
    expect(parts).toBeGreaterThan(2);
    await f.t.mutation(internal.mcp.reports.admission.finish, { ...run, parts, watermark: f.watermark });
    await complete(f, run);
    const row = await f.t.run((ctx) => ctx.db.get("mcpReportRequests", run.requestId));
    expect(row).toMatchObject({ status: "ready", payloadParts: parts, payloadRunToken: "run-1" });
    expect(row?.resultJson).toBeUndefined();
    // Polling reads only the row: no answer data in the status.
    const [state] = JSON.parse(
      await f.t.query(internal.mcp.reports.planning.jobStates, { caller: f.caller, jobs: [runJob] }),
    ) as JobAnswer[];
    expect(state).toEqual({ status: "ready", source: { kind: "mcp", requestId: run.requestId }, watermark: f.watermark });
    const read = await f.t.query(internal.mcp.reports.planning.jobAnswer, { caller: f.caller, source: state.source! });
    expect(read).toBe(json);
  });

  it("answers pending while a part is missing, and never reads another tenant's parts", async () => {
    const f = await fixture();
    const { run } = await running(f);
    const parts = await store(f, run, bigAnswer(2));
    await f.t.mutation(internal.mcp.reports.admission.finish, { ...run, parts, watermark: f.watermark });
    await complete(f, run);
    const source = { kind: "mcp" as const, requestId: run.requestId };
    const other = await seedAdminTenant(f.t, { prefix: "second_", orgId: "org_second" });
    expect(
      await f.t.query(internal.mcp.reports.planning.jobAnswer, {
        caller: adminCaller(other.orgId, "test", "second_user_jordan"),
        source,
      }),
    ).toBeNull();
    await f.t.run(async (ctx) => {
      const first = await ctx.db.query("mcpReportPayloads").first();
      await ctx.db.delete("mcpReportPayloads", first!._id);
    });
    expect(await f.t.query(internal.mcp.reports.planning.jobAnswer, { caller: f.caller, source })).toBeNull();
  });

  it("refuses parts from a stale run and deletes them in small batches", async () => {
    const f = await fixture();
    const { run } = await running(f);
    const parts = await store(f, run, bigAnswer(6));
    // A newer run took the request over.
    await f.t.run((ctx) => ctx.db.patch("mcpReportRequests", run.requestId, { runToken: "run-2" }));
    expect(
      await f.t.mutation(internal.mcp.reports.admission.storePart, { ...run, index: parts, json: "{}" }),
    ).toBe(false);
    await f.t.mutation(internal.mcp.reports.admission.finish, { ...run, parts, watermark: f.watermark });
    const row = await f.t.run((ctx) => ctx.db.get("mcpReportRequests", run.requestId));
    expect(row?.payloadParts).toBeUndefined();
    expect(await partCount(f)).toBe(parts);
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await partCount(f)).toBe(0);
  });

  it("deletes a failed or out-of-date run's parts and keeps the row failed", async () => {
    const f = await fixture();
    for (const outcome of ["error", "sync_changed"] as const) {
      const { run } = await running(f, `test:${outcome}`);
      const parts = await store(f, run, bigAnswer(1.5));
      if (outcome === "sync_changed")
        await f.t.run(async (ctx) => {
          const sync = await ctx.db.query("analyticsSync").first();
          await ctx.db.patch("analyticsSync", sync!._id, { watermark: f.watermark + 60_000 });
        });
      await f.t.mutation(internal.mcp.reports.admission.finish, {
        ...run,
        ...(outcome === "error" ? { error: "warehouse_failed" } : { parts, watermark: f.watermark }),
      });
      await complete(f, run);
      const row = await f.t.run((ctx) => ctx.db.get("mcpReportRequests", run.requestId));
      expect(row).toMatchObject({ status: "failed", error: outcome === "error" ? "warehouse_failed" : "sync_changed" });
      await f.t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await partCount(f)).toBe(0);
    }
  });

  it("drops the old answer's parts when a key is admitted again", async () => {
    const f = await fixture();
    const { run, job: runJob } = await running(f);
    const parts = await store(f, run, bigAnswer(1.5));
    await f.t.mutation(internal.mcp.reports.admission.finish, { ...run, parts, watermark: f.watermark });
    await complete(f, run);
    // The answer expired with the next sync; the agent asks again.
    await f.t.run((ctx) => ctx.db.patch("mcpReportRequests", run.requestId, { expiresAt: Date.now() - 1 }));
    await f.t.mutation(internal.mcp.reports.admission.admit, { caller: f.caller, jobs: [runJob] });
    const row = await f.t.run((ctx) => ctx.db.get("mcpReportRequests", run.requestId));
    expect(row?.payloadParts).toBeUndefined();
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await partCount(f)).toBe(0);
  });

  it("prunes an expired request's parts after the request", async () => {
    const f = await fixture();
    const { run } = await running(f);
    const parts = await store(f, run, bigAnswer(1.5));
    await f.t.mutation(internal.mcp.reports.admission.finish, { ...run, parts, watermark: f.watermark });
    await complete(f, run);
    await f.t.run((ctx) => ctx.db.patch("mcpReportRequests", run.requestId, { expiresAt: Date.now() - 1 }));
    await f.t.mutation(internal.mcp.access.pruneDaily, {});
    expect(await f.t.run((ctx) => ctx.db.get("mcpReportRequests", run.requestId))).toBeNull();
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await partCount(f)).toBe(0);
  });

  it("doesn't retry a range that was too large until the key expires", () => {
    const now = Date.now();
    expect(
      failedJobRetryable({ status: "failed", error: "range_too_large", finishedAt: now - 3_600_000, createdAt: now - 3_600_000 }, now),
    ).toBe(false);
    expect(
      failedJobRetryable({ status: "failed", error: "warehouse_failed", finishedAt: now - 61_000, createdAt: now - 61_000 }, now),
    ).toBe(true);
  });
});
