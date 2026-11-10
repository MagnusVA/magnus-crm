import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Infer } from "convex/values";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { callTool, createMcpHarness, mcpConnect, seedTenantWithLeadGen } from "../../tests/mcpHarness";
import { reportResultValidator } from "./tools/leadGenReport";
import { groupRowsByTeam } from "../../lib/lead-gen/team-rollup";
import { leadDashboardOverview, leadDashboardWorkers, leadDashboardOriginsByTeam } from "../../lib/operations-reports/lead-dashboard";
import { mergeLeadGenOverview, mergeLeadGenWorkers, mergeLeadGenTopOriginsByTeam, mergeLeadGenProspectConversions, mergeLeadGenResparkPerformance } from "../analytics/merge/leadGen";
import { analyticsArgsKey, canonicalJson, resolveReportRequest, reportDefinitionFor } from "../analytics/keys";
import { DEFAULT_BUSINESS_DAY } from "../../lib/businessDay";
import { REPORT_DEFINITION_VERSION, normalizeReportRange } from "../operations/reports/contracts";

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
  const admin = h.t.withIdentity({ subject: "user_admin", org_id: seed.orgId });
  // A shared team and origin, a repeated prospect across workers and sources.
  for (const day of ["2026-10-01", "2026-10-14", TODAY]) {
    vi.setSystemTime(Date.parse(`${day}T18:00:00Z`));
    for (const [sub, source, handle] of [
      ["user_sofia", "instagram", "shared"], ["user_dani", "instagram", "shared"],
      ["user_dani", "meta_business", "other"],
    ] as const) await h.t.withIdentity({ subject: sub, org_id: seed.orgId }).mutation(api.leadGen.capture.submit, {
      source, rawHandleOrProfileUrl: `@${handle}`, originKind: "post", rawOriginValue: "https://www.instagram.com/p/SharedPost/",
    });
  }
  vi.setSystemTime(NOW);
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
  expect(section(result, "specialists").rows).toEqual(data.workers.map(({ worker: _, email: __, ...r }) => { void _; void __; return r; }));
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
  source?: "instagram" | "meta_business", status: "ready" | "pending" | "failed" = "ready") {
  vi.stubEnv("CLICKHOUSE_URL", "https://clickhouse.invalid");
  vi.stubEnv("CLICKHOUSE_USER", "test"); vi.stubEnv("CLICKHOUSE_PASSWORD", "test");
  await h.t.run(async ctx => {
    await ctx.db.patch("tenants", h.tenantId, { analyticsReports: ["lead_gen"] });
    const range = { kind: "custom" as const, startDate, endDateInclusive };
    for (const name of ALL.filter(s => s !== "teams")) {
      const filters = name === "conversions" ? {} : { source: source ?? null, ...(name === "top_posts" ? { limitPerTeam: 10, sortBy: "submissions" } : {}) };
      const me = { tenantId: h.tenantId, userId: h.adminId, role: "tenant_admin" as const, workosUserId: "user_admin" };
      const request = await resolveReportRequest(ctx, { reportId: ids[name], filters, range, timeZone: DEFAULT_BUSINESS_DAY.timeZone }, reportDefinitionFor(ids[name]), me);
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

describe("lead gen report through /mcp", () => {
  it.each([TODAY, "2026-10-14"])("matches every live page section on %s with source filtering", async day => {
    const h = await fixture();
    const result = await run(h, { startDate: day, endDate: day, sections: ALL, source: "instagram" });
    parity(result, await web(h, day, day, "instagram"), h);
    for (const s of result.sections) expect(s).toMatchObject({ state: "ready", source: "live", asOf: NOW });
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
    expect(section(result, "top_posts").rows[0]).toMatchObject({ teamId: h.teamId, submissions: 3 });
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
    for (const s of result.sections) expect(s).toMatchObject({ source: "warehouse", state: "ready", asOf: NOW });
    expect(section(result, "top_posts").rankingPartial).toBe(true);
  });
  it("reads all-history warehouse sections without adding today", async () => {
    const h = await fixture();
    const past = await web(h, "2026-10-12", "2026-10-14", "meta_business");
    await seedWarehouse(h, past, "2026-10-12", "2026-10-14", "meta_business");
    const result = await run(h, { startDate: "2026-10-12", endDate: "2026-10-14", sections: ALL, source: "meta_business" });
    parity(result, past, h);
    expect(section(result, "top_posts").rankingPartial).toBe(false);
  });
  it("substitutes only the snapshot sections and matches the page's snapshot projections", async () => {
    const h = await fixture();
    const expected = await seedSnapshot(h, "2026-10-01", TODAY, "instagram");
    const result = await run(h, { startDate: "2026-10-01", endDate: TODAY, source: "instagram", sections: ALL });
    parity(result, expected, h);
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
});
