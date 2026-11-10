import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Infer } from "convex/values";
import { insertResparkItem } from "../lib/respark/items";
import { api } from "../_generated/api";
import { callTool, createMcpHarness, mcpConnect, seedTenantWithLeadGen } from "../../tests/mcpHarness";
import { reportResultValidator } from "./tools/leadGenReport";
import { groupRowsByTeam } from "../../lib/lead-gen/team-rollup";
import { leadDashboardOverview, leadDashboardWorkers, leadDashboardOriginsByTeam } from "../../lib/operations-reports/lead-dashboard";
import { mergeLeadGenOverview, mergeLeadGenWorkers, mergeLeadGenTopOriginsByTeam, mergeLeadGenProspectConversions, mergeLeadGenResparkPerformance } from "../analytics/merge/leadGen";
import { canonicalJson, resolveReportRequest, reportDefinitionFor } from "../analytics/keys";
import { DEFAULT_BUSINESS_DAY } from "../../lib/businessDay";
import { REPORT_DEFINITION_VERSION, normalizeReportRange } from "../operations/reports/contracts";
import { formatLocal } from "./time";

const TIME_ZONE = "America/Los_Angeles";
const NOW = Date.parse("2026-10-15T18:00:00Z");
const TODAY = "2026-10-15";
const ALL = ["overview", "specialists", "teams", "top_posts", "conversions", "respark"] as const;
type Section = typeof ALL[number];
type Result = Infer<typeof reportResultValidator>;
type Harness = Awaited<ReturnType<typeof fixture>>;
const TOOL = "magnus_lead_gen_report";
const ids: Record<Section, string> = { overview: "lead_gen.overview", specialists: "lead_gen.workers", teams: "lead_gen.workers", top_posts: "lead_gen.top_origins_by_team", conversions: "lead_gen.prospect_conversions", respark: "lead_gen.respark_performance" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
async function fixture() {
  const h = await createMcpHarness();
  const seed = await seedTenantWithLeadGen(h.t);
  await h.t.run(ctx => ctx.db.patch("users", seed.adminId, { timezone: TIME_ZONE }));
  const admin = h.t.withIdentity({ subject: "user_admin", org_id: seed.orgId });
  // A shared team and origin, a repeated prospect across workers and sources.
  for (const day of ["2026-10-01", "2026-10-14", TODAY]) {
    vi.setSystemTime(Date.parse(`${day}T18:00:00Z`));
    for (const [sub, source, handle] of [
      ["user_sofia", "instagram", "shared"], ["user_dani", "instagram", "shared"],
      ["user_dani", "meta_business", "other"],
    ] as const) await h.t.withIdentity({ subject: sub, org_id: seed.orgId }).mutation(api.leadGen.capture.submit, {
      source, rawHandleOrProfileUrl: `@${handle}`, originKind: "post", originUrlOrLabel: "https://www.instagram.com/p/SharedPost/",
    });
  }
  vi.setSystemTime(NOW);
  // Nonzero schedules and resparks expose source filtering and rate mistakes.
  await h.t.run(async ctx => {
    const prospect = (await ctx.db.query("leadGenProspects").first())!;
    for (const [dayIndex, day] of ["2026-10-14", TODAY].entries()) {
      const at = Date.parse(`${day}T18:00:00Z`);
      const batchId = await ctx.db.insert("resparkBatches", { tenantId: seed.tenantId, teamId: seed.teamId,
        userId: seed.sofiaId, workerId: seed.sofiaWorkerId, createdAt: at, heldUntil: at + 60000, size: 2, requestedSize: 2 });
      for (const [position, result] of (["resparked", "not_a_fit"] as const).entries()) {
        await insertResparkItem(ctx, { tenantId: seed.tenantId, batchId, leadId: prospect.leadId,
          userId: seed.sofiaId, workerId: seed.sofiaWorkerId, position, bucket: 1, heldUntil: at + 60000, result, workedAt: at });
      }
      await ctx.db.insert("leadGenWorkerSchedules", { tenantId: seed.tenantId, workerId: seed.sofiaWorkerId, userId: seed.sofiaId,
        weekday: dayIndex === 0 ? "wednesday" : "thursday", scheduledHours: 6, updatedByUserId: seed.adminId, updatedAt: at });
    }
  });
  const token = await h.signToken("user_admin", { org_id: seed.orgId });
  const { sessionId } = await mcpConnect(h.t, token);
  return { ...h, ...seed, admin, token, sessionId };
}
async function run(h: Harness, args: Record<string, unknown> = {}) {
  const call = await callTool(h.t, h.token, h.sessionId, TOOL, args);
  expect(call.response.body?.error, call.text).toBeUndefined();
  expect(call.isError, call.text).toBe(false);
  return call.data as Result;
}
const byWorker = (a: Result["sections"][number]["rows"][number], b: Result["sections"][number]["rows"][number]) =>
  ("workerId" in a ? a.workerId : "").localeCompare("workerId" in b ? b.workerId : "");
const section = (r: Result, name: Section) => r.sections.find(s => s.section === name)!;
async function web(h: Harness, startDayKey: string, endDayKey: string, source?: "instagram" | "meta_business") {
  const args = { startDayKey, endDayKey, ...(source ? { source } : {}) };
  const overview = await h.admin.query(api.leadGen.reporting.getOverview, args);
  const workers = await h.admin.query(api.leadGen.reporting.listWorkerPerformance, args);
  const posts = await h.admin.query(api.leadGen.reporting.listTopOriginsByTeam, { ...args, limitPerTeam: 10, sortBy: "submissions" });
  const conversions = await h.admin.query(api.leadGen.conversions.listProspectConversions, { startDayKey, endDayKey });
  const resparks = await h.admin.query(api.leadGen.resparkReports.listResparkPerformance, args);
  return { overview, workers, posts, conversions, resparks };
}
function parity(result: Result, data: Awaited<ReturnType<typeof web>>, h: Harness) {
  expect(section(result, "overview").rows).toEqual([{ submissions: data.overview.submissions, uniqueProspects: data.overview.uniqueProspects,
    duplicates: data.overview.duplicates, scheduledHours: data.overview.scheduledHours, leadsPerHour: data.overview.leadsPerHour }]);
  expect([...section(result, "specialists").rows].sort(byWorker)).toEqual(data.workers.map(({ worker: _, email: __, ...r }) => { void _; void __; return r; }).sort(byWorker));
  expect(section(result, "teams").rows).toEqual(groupRowsByTeam(data.workers, [{ _id: h.teamId, name: "Team A" }]).map(g => ({
    teamId: g.teamId, teamName: g.teamName, submissions: g.submissions, scheduledHours: g.scheduledHours,
    leadsPerHour: g.scheduledHours > 0 ? g.submissions / g.scheduledHours : null, specialistCount: g.rows.length,
  })));
  expect(section(result, "top_posts").rows).toEqual(data.posts.flatMap(g => g.origins.map(o => ({
    teamId: g.teamId, teamName: g.teamName, totalSubmissions: g.totalSubmissions,
    originKey: o.originKey, source: o.source, originKind: o.originKind, originValue: o.originValue,
    submissions: o.submissions, uniqueProspects: o.uniqueProspects,
  }))));
  expect(section(result, "conversions").rows).toEqual(data.conversions.rows.map(({ worker: _, ...r }) => { void _; return r; }));
  expect(section(result, "respark").rows).toEqual(data.resparks.rows.map(({ worker, ...r }) => ({ ...r, displayName: worker.name!, teamId: h.teamId })));
}

async function seedWarehouse(h: Harness, data: Awaited<ReturnType<typeof web>>, startDate: string, endDateInclusive: string,
  source?: "instagram" | "meta_business", status: "ready" | "pending" | "queued" | "failed" = "ready") {
  if (status === "queued") vi.stubEnv("ANALYTICS_DAILY_RUN_BUDGET", "0");
  vi.stubEnv("CLICKHOUSE_URL", "https://clickhouse.invalid");
  vi.stubEnv("CLICKHOUSE_USER", "test"); vi.stubEnv("CLICKHOUSE_PASSWORD", "test");
  await h.t.run(async ctx => {
    await ctx.db.patch("tenants", h.tenantId, { analyticsReports: ["lead_gen"] });
    const range = { kind: "custom" as const, startDate, endDateInclusive };
    for (const name of ALL.filter(s => s !== "teams")) {
      const filters = name === "conversions" ? {} : { source: source ?? null, ...(name === "top_posts" ? { limitPerTeam: 10, sortBy: "submissions" } : {}) };
      const me = { tenantId: h.tenantId, userId: h.adminId, role: "tenant_admin" as const, workosUserId: "user_admin" };
      const request = await resolveReportRequest(ctx, { reportId: ids[name], filters, range, timeZone: DEFAULT_BUSINESS_DAY.timeZone }, reportDefinitionFor(ids[name]), me);
      const existing = await ctx.db.query("analyticsResults").withIndex("by_tenantId_and_reportId_and_argsKey", q => q.eq("tenantId", h.tenantId).eq("reportId", ids[name]).eq("argsKey", request.argsKey)).unique();
      if (existing) continue;
      const value = name === "overview" ? data.overview : name === "specialists" ? data.workers : name === "top_posts" ? data.posts : name === "conversions" ? data.conversions : data.resparks;
      const payloadId = await ctx.db.insert("analyticsPayloads", { tenantId: h.tenantId, json: JSON.stringify(value) });
      await ctx.db.insert("analyticsResults", { tenantId: h.tenantId, reportId: ids[name], range,
        argsKey: request.argsKey, filtersJson: canonicalJson(request.filters), timeZone: DEFAULT_BUSINESS_DAY.timeZone, dayStartHour: DEFAULT_BUSINESS_DAY.dayStartHour,
        status, payloadId, answer: { watermark: NOW, completedAt: NOW - 1000, startDate, endDateInclusive },
        ...(status === "pending" ? { run: { id: "test-run", watermark: NOW, startedAt: NOW } } : {}),
        ...(status === "failed" ? { failedAt: NOW, errorMessage: "fixture failed" } : {}), lastRequestedAt: NOW - 2 * 3600_000 });
    }
  });
}

async function seedSnapshot(h: Harness, startDayKey: string, endDayKey: string, source?: "instagram" | "meta_business",
  status: "ready" | "queued" | "failed" = "ready") {
  const data = await web(h, startDayKey, endDayKey, source);
  await h.t.run(async ctx => {
    const range = normalizeReportRange({ reportKind: "lead-gen", input: { kind: "custom", startBusinessDate: startDayKey, endBusinessDateInclusive: endDayKey }, setting: DEFAULT_BUSINESS_DAY, businessDayVersion: 0, now: NOW });
    const { buildReportRequestKey } = await import("../operations/reports/contracts");
    const requestKey = buildReportRequestKey({ purpose: "dashboard", reportKind: "lead-gen", range, sourceFilter: source ?? "all" });
    const jobId = await ctx.db.insert("operationsReportJobs", { tenantId: h.tenantId, requestedByUserId: h.adminId,
      purpose: "dashboard", reportKind: "lead-gen", range, sourceFilter: source ?? "all", requestToken: "fixture", requestKey,
      definitionVersion: REPORT_DEFINITION_VERSION, status, phase: status === "ready" ? "ready" : "queued", rowsProcessed: 0,
      pagesProcessed: 0, artifactCount: 0, checkpointSequence: 0, leaseGeneration: 0, retryCount: 0, cleanupPending: false,
      queuedAt: NOW, createdAt: NOW, ...(status === "ready" ? { completedAt: NOW } : {}) });
    await ctx.db.insert("operationsReportAdmission", { tenantId: h.tenantId, slots: [{ jobId, userId: h.adminId, purpose: "dashboard", requestKey }] });
    const row = (section: string, rowKey: string, payload: Record<string, string | number | boolean | null>, sortValue = 0) => ctx.db.insert("operationsReportRows", { tenantId: h.tenantId, jobId, rowType: "result", section, rowKey, payload, sortValue, updatedAt: NOW });
    await row("lead_gen_summary", "main", data.overview);
    for (const w of data.workers) await row("lead_gen_worker", w.workerId, { workerId: w.workerId, label: w.displayName, teamId: w.teamId,
      teamLabel: "Team A", isActive: w.isActive, submissions: w.submissions, uniqueProspects: w.uniqueProspects, duplicates: w.duplicates, scheduledHours: w.scheduledHours, leadsPerHour: w.leadsPerHour }, w.submissions);
    for (const g of data.posts) for (const o of g.origins) await row("lead_gen_team_origin", `${g.teamId}:${o.originKey}`, { ...o, teamId: g.teamId, teamLabel: g.teamName }, o.submissions);
  });
  return data;
}

async function warehouseRequested(h: Harness) {
  await vi.waitFor(async () => {
    const rows = await h.t.run(ctx => ctx.db.query("analyticsResults").take(10));
    expect(rows.every(r => r.lastRequestedAt >= NOW)).toBe(true);
  });
}
async function setWarehouseStatus(h: Harness, status: "ready" | "failed") {
  await h.t.run(async ctx => {
    for (const row of await ctx.db.query("analyticsResults").take(10)) {
      await ctx.db.patch("analyticsResults", row._id, { status, run: undefined, ...(status === "failed" ? { failedAt: Date.now() } : {}) });
    }
  });
}
function unavailable(result: Result, state: "pending" | "failed" | "rebuilding", names: readonly Section[] = ALL) {
  for (const name of names) expect(section(result, name)).toMatchObject({ state, rows: [], asOf: null, cursor: null });
}

describe("lead gen report through /mcp", () => {
  it.each([TODAY, "2026-10-14"])("matches every live page section on %s with source filtering", async day => {
    const h = await fixture();
    const result = await run(h, { startDate: day, endDate: day, sections: ALL, source: "instagram" });
    parity(result, await web(h, day, day, "instagram"), h);
    for (const s of result.sections) expect(s).toMatchObject({ state: "ready", source: "live", asOf: formatLocal(NOW, TIME_ZONE) });
    expect(section(result, "conversions").effectiveFilters).toEqual({ startDayKey: day, endDayKey: day });
    expect(section(result, "respark").effectiveFilters).toEqual({ startDayKey: day, endDayKey: day, source: "instagram", sourceAppliesTo: "rawLeads" });
    expect(JSON.stringify(result)).not.toContain("imageUrl");
  });
  it("defaults to overview and specialists and refuses every unsupported argument", async () => {
    const h = await fixture();
    expect((await run(h)).sections.map(s => s.section)).toEqual(["overview", "specialists"]);
    for (const extra of [{ teamId: h.teamId }, { workerId: h.sofiaWorkerId }, { madeUp: true }]) {
      const result = await callTool(h.t, h.token, h.sessionId, TOOL, extra);
      expect(result.response.body?.error ?? result.isError).toBeTruthy();
      expect(result.data).not.toHaveProperty("sections");
    }
  });
  it("uses current teams for the rollup and capture-time teams for posts", async () => {
    const h = await fixture();
    await h.t.run(ctx => ctx.db.patch("leadGenWorkers", h.sofiaWorkerId, { teamId: undefined }));
    const result = await run(h, { sections: ALL });
    expect(section(result, "teams").rows).toHaveLength(2);
    expect(section(result, "teams").rows[1]).toMatchObject({ teamId: null, submissions: 1 });
    expect(section(result, "top_posts").rows[0]).toMatchObject({ teamId: h.teamId, submissions: 2 });
  });
  it("matches warehouse history merged with today, including the source scope", async () => {
    const h = await fixture();
    const past = await web(h, "2026-10-13", "2026-10-14", "instagram");
    await seedWarehouse(h, past, "2026-10-13", "2026-10-14", "instagram");
    const today = await web(h, TODAY, TODAY, "instagram");
    const result = await run(h, { startDate: "2026-10-13", endDate: TODAY, sections: ALL, source: "instagram" });
    parity(result, { overview: mergeLeadGenOverview(past.overview, today.overview), workers: mergeLeadGenWorkers(past.workers, today.workers),
      posts: mergeLeadGenTopOriginsByTeam(past.posts, today.posts), conversions: mergeLeadGenProspectConversions(past.conversions, today.conversions),
      resparks: mergeLeadGenResparkPerformance(past.resparks, today.resparks) }, h);
    for (const s of result.sections) expect(s).toMatchObject({ source: "warehouse", state: "ready", asOf: formatLocal(NOW, TIME_ZONE) });
    expect(section(result, "top_posts").rankingPartial).toBe(true);
  });
  it("reads all-history warehouse sections without adding today", async () => {
    const h = await fixture();
    const past = await web(h, "2026-10-12", "2026-10-14", "meta_business");
    await seedWarehouse(h, past, "2026-10-12", "2026-10-14", "meta_business");
    const result = await run(h, { startDate: "2026-10-12", endDate: "2026-10-14", sections: ALL, source: "meta_business" });
    parity(result, past, h);
    for (const s of result.sections) expect(s.asOf).toBe(formatLocal(NOW, TIME_ZONE));
    expect(section(result, "top_posts").rankingPartial).toBe(false);
  });
  it("substitutes only the snapshot sections and matches the page's snapshot projections", async () => {
    const h = await fixture();
    const expected = await seedSnapshot(h, "2026-10-01", TODAY, "instagram");
    const result = await run(h, { startDate: "2026-10-01", endDate: TODAY, source: "instagram", sections: ALL });
    parity(result, expected, h);
    for (const s of result.sections) expect(s.asOf).toBe(formatLocal(NOW, TIME_ZONE));
    for (const name of ALL) expect(section(result, name).source).toBe(["conversions", "respark"].includes(name) ? "live" : "snapshot");
    // Independently read the actual page's job API and transformations.
    const job = (await h.t.run(ctx => ctx.db.query("operationsReportJobs").first()))!;
    const summary = await h.admin.query(api.operations.reports.jobs.getDashboardReportSummary, { jobId: job._id });
    expect(section(result, "overview").rows).toEqual([(({ capped: _, ...r }) => { void _; return r; })(leadDashboardOverview(summary!.payload))]);
    const workers = await h.admin.query(api.operations.reports.jobs.listDashboardReportRows, { jobId: job._id, section: "lead_gen_worker", paginationOpts: { cursor: null, numItems: 100 } });
    expect(leadDashboardWorkers(workers.page).map(w => w.submissions)).toEqual(section(result, "specialists").rows.map(r => "submissions" in r ? r.submissions : null));
    const posts = await h.admin.query(api.operations.reports.jobs.listDashboardReportRows, { jobId: job._id, section: "lead_gen_team_origin", paginationOpts: { cursor: null, numItems: 100 } });
    expect(leadDashboardOriginsByTeam(posts.page).flatMap(g => g.origins).map(o => o.submissions)).toEqual(section(result, "top_posts").rows.map(r => "submissions" in r ? r.submissions : null));
  });
  it("falls back to a snapshot when a short live overview caps", async () => {
    const h = await fixture();
    await seedSnapshot(h, TODAY, TODAY, "instagram");
    await h.t.run(async ctx => {
      for (let i = 0; i < 1001; i++) await ctx.db.insert("leadGenTeamOriginStats", { tenantId: h.tenantId, teamId: h.teamId, source: "instagram",
        dayKey: TODAY, statKey: `overflow${i}`, originKind: "post", originKey: `overflow${i}`, originValue: `https://www.instagram.com/p/overflow${i}/`, submissions: 1, uniqueProspectsSubmitted: 1, updatedAt: NOW });
    });
    expect((await h.admin.query(api.leadGen.reporting.getOverview, { startDayKey: TODAY, endDayKey: TODAY, source: "instagram" })).capped).toBe(true);
    const result = await run(h, { sections: ALL, source: "instagram" });
    expect(section(result, "overview")).toMatchObject({ source: "snapshot", state: "ready" });
    expect(section(result, "conversions").source).toBe("live");
    expect(section(result, "respark").source).toBe("live");
  });

  it.each(["queued", "failed"] as const)("exposes no stale warehouse numbers when every section is %s", async status => {
    const h = await fixture();
    await seedWarehouse(h, await web(h, "2026-10-13", "2026-10-14"), "2026-10-13", "2026-10-14", undefined, status);
    const result = await run(h, { startDate: "2026-10-13", endDate: TODAY, sections: ALL });
    unavailable(result, status === "queued" ? "pending" : "failed");
  });
  it("waits for pending warehouse sections and merges the completed generation", async () => {
    const h = await fixture();
    const past = await web(h, "2026-10-13", "2026-10-14");
    await seedWarehouse(h, past, "2026-10-13", "2026-10-14", undefined, "pending");
    const answer = run(h, { startDate: "2026-10-13", endDate: TODAY, sections: ALL });
    await warehouseRequested(h);
    await setWarehouseStatus(h, "ready");
    const today = await web(h, TODAY, TODAY);
    parity(await answer, { overview: mergeLeadGenOverview(past.overview, today.overview), workers: mergeLeadGenWorkers(past.workers, today.workers),
      posts: mergeLeadGenTopOriginsByTeam(past.posts, today.posts), conversions: mergeLeadGenProspectConversions(past.conversions, today.conversions),
      resparks: mergeLeadGenResparkPerformance(past.resparks, today.resparks) }, h);
  });
  it("uses one deadline for all pending warehouse sections, returning no figures", async () => {
    const h = await fixture();
    await seedWarehouse(h, await web(h, "2026-10-13", "2026-10-14"), "2026-10-13", "2026-10-14", undefined, "pending");
    const answer = run(h, { startDate: "2026-10-13", endDate: TODAY, sections: ALL });
    await warehouseRequested(h);
    vi.setSystemTime(NOW + 30000);
    unavailable(await answer, "pending");
  });
  it("refuses delayed results after access is revoked during warehouse polling", async () => {
    const h = await fixture();
    await seedWarehouse(h, await web(h, "2026-10-13", "2026-10-14"), "2026-10-13", "2026-10-14", undefined, "pending");
    const answer = callTool(h.t, h.token, h.sessionId, TOOL, { startDate: "2026-10-13", endDate: TODAY, sections: ALL });
    await warehouseRequested(h);
    await h.t.run(ctx => ctx.db.patch("users", h.adminId, { mcpBlockedAt: NOW }));
    const result = await answer;
    expect(result.response.body?.error ?? result.isError).toBeTruthy();
    expect(result.data).not.toHaveProperty("sections");
  });
  it.each(["live", "split", "snapshot", "history"] as const)("keeps conversions independent while %s business-day buckets rebuild", async route => {
    const h = await fixture();
    const startDate = route === "live" ? TODAY : route === "snapshot" ? "2026-10-01" : "2026-10-13";
    const endDate = route === "history" ? "2026-10-14" : TODAY;
    const expected = await web(h, startDate, endDate);
    if (route === "split" || route === "history") await seedWarehouse(h, await web(h, startDate, "2026-10-14"), startDate, "2026-10-14");
    await h.t.run(ctx => ctx.db.insert("businessDayRebuilds", { tenantId: h.tenantId, version: 0, requestedAt: NOW,
      state: "running", phase: "compute", cursor: null, pass: 0, sourceRevision: 0, computedRevision: 0,
      meetingsEnqueued: 0, leadGenRowsComputed: 0, leadGenRowsSwapped: 0, leadGenAudited: 0,
      meetingsAsserted: 0, bucketsAsserted: 0, sourcesAsserted: 0, leadGenDone: false }));
    const result = await run(h, { startDate, endDate, sections: ALL });
    expect(section(result, "conversions").rows).toEqual(expected.conversions.rows.map(({ worker: _, ...r }) => { void _; return r; }));
    if (route === "history") parity(result, expected, h);
    else unavailable(result, "rebuilding", ALL.filter(s => s !== "conversions"));
    await expect(h.admin.query(api.leadGen.reporting.getOverview, { startDayKey: startDate, endDayKey: endDate })).rejects.toThrow(/rebuilt/i);
  });
  it.each(["queued", "failed"] as const)("keeps independent live sections while snapshot sections are %s", async status => {
    const h = await fixture();
    const data = await seedSnapshot(h, "2026-10-01", TODAY, "instagram", status);
    const answer = run(h, { startDate: "2026-10-01", endDate: TODAY, sections: ALL, source: "instagram" });
    if (status === "queued") {
      // Wait for the coordinator to read the pending snapshot before its deadline.
      await new Promise(resolve => setTimeout(resolve, 100));
      vi.setSystemTime(NOW + 30000);
    }
    const result = await answer;
    unavailable(result, status === "queued" ? "pending" : "failed", ["overview", "specialists", "teams", "top_posts"]);
    expect(section(result, "conversions").state).toBe("ready");
    expect(section(result, "respark").rows).toEqual(data.resparks.rows.map(({ worker, ...r }) => ({ ...r, displayName: worker.name!, teamId: h.teamId })));
  });
  it("finds the snapshot it started when a pending report is asked for again", async () => {
    const h = await fixture();
    const ask = async () => {
      const answer = run(h, { startDate: "2026-10-01", endDate: TODAY, sections: ["overview"] });
      // Wait for the coordinator to request the snapshot, then pass its deadline.
      await new Promise(resolve => setTimeout(resolve, 100));
      vi.setSystemTime(Date.now() + 30000);
      return await answer;
    };
    unavailable(await ask(), "pending", ["overview"]);
    // The job finished in the meantime and gave up its admission slot.
    await h.t.run(async ctx => {
      const admission = (await ctx.db.query("operationsReportAdmission").first())!;
      await ctx.db.patch("operationsReportAdmission", admission._id, { slots: [] });
    });
    await ask();
    expect(await h.t.run(ctx => ctx.db.query("operationsReportJobs").take(10))).toHaveLength(1);
  });
  it.each(["live", "warehouse", "snapshot"] as const)("refuses non-admins and isolates a second tenant on the %s route", async route => {
    const h = await fixture();
    for (const subject of ["user_sofia", "user_alex"]) {
      const token = await h.signToken(subject, { org_id: h.orgId }); const { sessionId } = await mcpConnect(h.t, token);
      const result = await callTool(h.t, token, sessionId, TOOL, { sections: ALL });
      expect(result.response.body?.error?.message ?? result.text).toContain("isn't available for your role");
    }
    const other = await seedTenantWithLeadGen(h.t, { orgId: "org_other", slug: "other" });
    const token = await h.signToken("other_user_admin", { org_id: other.orgId }); const { sessionId } = await mcpConnect(h.t, token);
    const otherHarness = { ...h, ...other, token, sessionId, admin: h.t.withIdentity({ subject: "other_user_admin", org_id: other.orgId }) };
    const startDate = route === "snapshot" ? "2026-10-01" : route === "warehouse" ? "2026-10-13" : TODAY;
    if (route === "warehouse") {
      await seedWarehouse(h, await web(h, startDate, "2026-10-14"), startDate, "2026-10-14");
      await seedWarehouse(otherHarness, await web(otherHarness, startDate, "2026-10-14"), startDate, "2026-10-14");
    }
    if (route === "snapshot") {
      await seedSnapshot(h, startDate, TODAY);
      await seedSnapshot(otherHarness, startDate, TODAY);
    }
    const result = await run(otherHarness, { sections: ALL, startDate, endDate: TODAY });
    expect(result.sections).toHaveLength(6);
    const json = JSON.stringify(result);
    for (const id of [h.sofiaWorkerId, h.daniWorkerId, h.teamId]) expect(json).not.toContain(id);
    expect(section(result, "overview").rows).toMatchObject([{ submissions: 0 }]);
    expect(section(result, "specialists").rows).toEqual([]);
    expect(section(result, "conversions").rows).toEqual([]);
    expect(section(result, "respark").rows).toHaveLength(2);
  });
  it.each(["live", "warehouse", "snapshot"] as const)("continues %s specialists with no gaps and refuses foreign or stale generations", async route => {
    const h = await fixture();
    await h.t.run(async ctx => {
      for (let i = 0; i < (route === "live" ? 28 : 108); i++) {
        const workerId = await ctx.db.insert("leadGenWorkers", { tenantId: h.tenantId, userId: h.sofiaId, workosUserId: `fixture-${i}`, email: `worker${i}@test.example`, displayName: `Worker ${i}`, teamId: h.teamId, isActive: true, createdAt: NOW, updatedAt: NOW });
        await ctx.db.insert("leadGenDailyStats", { tenantId: h.tenantId, workerId, userId: h.sofiaId, statKey: `page-${i}`, source: "instagram",
          dayKey: "2026-10-14", submissions: i + 1, uniqueProspectsSubmitted: i + 1, duplicateProspectSubmissions: 0, scheduledHours: 0, updatedAt: NOW });
      }
    });
    const startDate = route === "snapshot" ? "2026-10-01" : "2026-10-14";
    const endDate = route === "live" ? startDate : TODAY;
    const args = { startDate, endDate, sections: ["specialists"], source: "instagram" };
    if (route === "warehouse") await seedWarehouse(h, await web(h, startDate, "2026-10-14", "instagram"), startDate, "2026-10-14", "instagram");
    if (route === "snapshot") await seedSnapshot(h, startDate, endDate, "instagram");
    const first = section(await run(h, args), "specialists");
    expect(first.rows).toHaveLength(25); expect(first.cursor).toBeTruthy(); expect(first.cappedFlags.rows).toBe(true);
    expect(first.source).toBe(route);
    const rows = [...first.rows];
    let cursor = first.cursor;
    while (cursor) {
      const next = section(await run(h, { ...args, cursor }), "specialists");
      expect(next.rows.length).toBeGreaterThan(0);
      expect(next.rows.length).toBeLessThanOrEqual(25);
      rows.push(...next.rows);
      cursor = next.cursor;
    }
    expect(rows).toHaveLength(route === "live" ? 30 : 110);
    expect(new Set(rows.map(r => "workerId" in r && r.workerId)).size).toBe(route === "live" ? 30 : 110);
    expect(rows.sort(byWorker)).toEqual((await web(h, startDate, endDate, "instagram")).workers.map(({ worker: _, email: __, ...r }) => { void _; void __; return r; }).sort(byWorker));
    for (const changed of [{ startDate: "2026-10-13" }, { sections: ["teams"] }, { source: "meta_business" }]) {
      const result = await callTool(h.t, h.token, h.sessionId, TOOL, { ...args, ...changed, cursor: first.cursor });
      expect(result.response.body?.error ?? result.isError).toBeTruthy();
    }
    if (route === "snapshot") {
      await h.t.run(async ctx => {
        const job = (await ctx.db.query("operationsReportJobs").first())!;
        await ctx.db.patch("operationsReportJobs", job._id, { status: "failed" });
      });
    } else {
      await h.t.run(ctx => ctx.db.patch("leadGenWorkers", h.sofiaWorkerId, { displayName: "Changed generation" }));
    }
    const stale = await callTool(h.t, h.token, h.sessionId, TOOL, { ...args, cursor: first.cursor });
    expect(stale.response.body?.error ?? stale.isError).toBeTruthy();
  });

  it("keeps successful split sections when today's top-post read caps", async () => {
    const h = await fixture();
    const past = await web(h, "2026-10-13", "2026-10-14", "instagram");
    await seedWarehouse(h, past, "2026-10-13", "2026-10-14", "instagram");
    await h.t.run(async ctx => {
      for (let i = 0; i < 1001; i++) await ctx.db.insert("leadGenTeamOriginStats", { tenantId: h.tenantId, teamId: h.teamId, source: "instagram",
        dayKey: TODAY, statKey: `overflow${i}`, originKind: "post", originKey: `overflow${i}`, originValue: `https://www.instagram.com/p/overflow${i}/`, submissions: 1, uniqueProspectsSubmitted: 1, updatedAt: NOW });
    });
    const dates = { startDayKey: TODAY, endDayKey: TODAY, source: "instagram" as const };
    const todayWorkers = await h.admin.query(api.leadGen.reporting.listWorkerPerformance, dates);
    await expect(h.admin.query(api.leadGen.reporting.listTopOriginsByTeam, dates)).rejects.toThrow(/too large/);
    const result = await run(h, { startDate: "2026-10-13", endDate: TODAY, sections: ALL, source: "instagram" });
    expect(section(result, "overview")).toMatchObject({ source: "warehouse", state: "ready", capped: true, cappedFlags: { capped: true } });
    expect(section(result, "specialists").rows).toEqual(mergeLeadGenWorkers(past.workers, todayWorkers).map(({ worker: _, email: __, ...r }) => { void _; void __; return r; }));
    unavailable(result, "failed", ["top_posts"]);
    for (const name of ["teams", "conversions", "respark"] as const) expect(section(result, name).state).toBe("ready");
  });

  it.each(["live", "warehouse", "snapshot"] as const)("applies the source filter only to the appropriate %s metrics", async route => {
    const h = await fixture();
    const startDate = route === "live" ? TODAY : route === "snapshot" ? "2026-10-01" : "2026-10-13";
    const results: Result[] = [];
    for (const source of ["instagram", "meta_business"] as const) {
      if (route === "warehouse") await seedWarehouse(h, await web(h, startDate, "2026-10-14", source), startDate, "2026-10-14", source);
      if (route === "snapshot") {
        // Reuse the same tenant's admission row for the page's second source.
        await h.t.run(async ctx => {
          const admission = await ctx.db.query("operationsReportAdmission").first();
          if (admission) await ctx.db.delete("operationsReportAdmission", admission._id);
        });
        await seedSnapshot(h, startDate, TODAY, source);
      }
      const result = await run(h, { startDate, endDate: TODAY, sections: ALL, source });
      // The full live window is an independent oracle for additive metrics.
      parity(result, await web(h, startDate, TODAY, source), h);
      results.push(result);
    }
    expect(section(results[0], "overview").rows).not.toEqual(section(results[1], "overview").rows);
    expect(section(results[0], "conversions").rows).toEqual(section(results[1], "conversions").rows);
    for (const result of results) {
      const resparks = section(result, "respark").rows;
      expect(resparks.find(r => "workerId" in r && r.workerId === h.sofiaWorkerId)).toMatchObject({ resparks: route === "live" ? 1 : 2, notAFit: route === "live" ? 1 : 2 });
    }
  });
  it.each([
    ["this_week", "2026-10-12", TODAY], ["last_week", "2026-10-05", "2026-10-11"], ["this_month", "2026-10-01", TODAY],
  ] as const)("resolves the %s preset to the page's business dates", async (range, startDate, endDate) => {
    const h = await fixture();
    if (range === "this_month") await seedSnapshot(h, startDate, endDate);
    const result = await run(h, { range, sections: ALL });
    parity(result, await web(h, startDate, endDate), h);
    for (const s of result.sections) expect(s.effectiveFilters).toEqual({ startDayKey: startDate, endDayKey: endDate });
  });
});
