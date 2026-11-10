import { afterEach, describe, expect, it, vi } from "vitest";
import workpool from "@convex-dev/workpool/test";
import { adminFixture, adminCaller } from "../../../tests/mcpAdminFixtures";
import { internal, api } from "../../_generated/api";
import { resolveAnalyticsRange } from "../../../lib/analyticsRange";
import { ASSISTANT_DAILY_RUN_ALLOWANCE, ASSISTANT_JOB_TIMEOUT_MS, type ReportJob } from "./contracts";
import { analyticsArgsKey } from "../../analytics/keys";
import type { Prepared } from "./planning";
async function fixture() {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-09T18:00:00Z"));
    const f = await adminFixture();
    workpool.register(f.t, "analyticsWorkpool");
    await f.t.run(ctx => ctx.db.patch("tenants", f.tenantId, { businessDayAppliedVersion: 0, analyticsReports: ["team", "revenue"] }));
    const watermark = Date.now() - 3600000;
    await f.t.run(ctx => ctx.db.insert("analyticsSync", { beatAt: Date.now(), watermark }));
    vi.stubEnv("CLICKHOUSE_URL", "https://clickhouse.example:8443");
    vi.stubEnv("CLICKHOUSE_USER", "magnus_app");
    vi.stubEnv("CLICKHOUSE_PASSWORD", "test");
    vi.stubGlobal("fetch", async (_url: string | URL, init?: {
        body?: string;
    }) => new Response(JSON.stringify({ data: String(init?.body).includes("analytics.watermark") ? [{ watermark, beats: 3 }] : [] }), { status: 200 }));
    return { ...f, caller: adminCaller(f.orgId), watermark };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function jobs(f: Fixture, count = 4): ReportJob[] {
    const range = { kind: "custom" as const, startDate: "2026-10-01", endDateInclusive: "2026-10-31" };
    const window = resolveAnalyticsRange(range, { timeZone: "America/Tegucigalpa", dayStartHour: 1 }, Date.now());
    return ["team.metrics", "team.operations", "team.outcomes", "team.actions"].slice(0, count).map(report => ({ key: `test:${report}`, report, range, window, syncWatermark: f.watermark, filtersJson: report === "team.operations" ? '{"bookingProgramId":null,"attributionTeamId":null,"dmCloserId":null}' : "{}" }));
}
async function rows(f: Fixture) { return f.t.run(ctx => ctx.db.query("mcpReportRequests").take(100)); }
async function advanceJob(f: Fixture, fail = false) {
    const row = (await rows(f)).find(r => r.status === "running")!;
    expect(row).toBeDefined();
    if (fail)
        await f.t.mutation(internal.mcp.reports.admission.finish, { requestId: row._id, runToken: row.runToken!, error: "test_failure" });
    else
        await f.t.action(internal.mcp.reports.runner.run, { requestId: row._id, runToken: row.runToken! });
    await f.t.mutation(internal.mcp.reports.admission.onComplete, { workId: row.workId as import("@convex-dev/workpool").WorkId, context: { requestId: row._id, runToken: row.runToken! }, result: { kind: "success", returnValue: null } });
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("isolated assistant report admission", () => {
    it("admits one running and two waiting, then completes four jobs over retries without analytics writes", async () => {
        const f = await fixture();
        const requested = jobs(f);
        await f.t.mutation(internal.mcp.reports.admission.admit, { caller: f.caller, jobs: requested });
        let saved = await rows(f);
        expect(saved.filter(r => r.status === "running")).toHaveLength(1);
        expect(saved.filter(r => r.status === "waiting")).toHaveLength(2);
        expect(saved.find(r => r.kind === "allowance")?.runCount).toBe(3);
        await advanceJob(f);
        await f.t.mutation(internal.mcp.reports.admission.admit, { caller: f.caller, jobs: requested });
        for (let i = 0; i < 3; i++) {
            saved = await rows(f);
            expect(saved.filter(r => r.status === "running").length).toBeLessThanOrEqual(1);
            expect(saved.filter(r => r.status === "waiting").length).toBeLessThanOrEqual(2);
            await advanceJob(f);
        }
        saved = await rows(f);
        expect(saved.filter(r => r.kind === "job" && r.status === "ready")).toHaveLength(4);
        expect(saved.find(r => r.kind === "allowance")?.runCount).toBe(4);
        expect(await f.t.run(ctx => ctx.db.query("analyticsResults").take(10))).toHaveLength(0);
    });
    it("deduplicates retries and counts each job once", async () => {
        const f = await fixture();
        const request = { caller: f.caller, jobs: jobs(f, 2) };
        await f.t.mutation(internal.mcp.reports.admission.admit, request);
        await f.t.mutation(internal.mcp.reports.admission.admit, request);
        const saved = await rows(f);
        expect(saved.filter(r => r.kind === "job")).toHaveLength(2);
        expect(saved.find(r => r.kind === "allowance")?.runCount).toBe(2);
    });
    it("recovers a permit after failure", async () => {
        const f = await fixture();
        await f.t.mutation(internal.mcp.reports.admission.admit, { caller: f.caller, jobs: jobs(f, 2) });
        await advanceJob(f, true);
        const saved = await rows(f);
        expect(saved.filter(r => r.status === "failed")).toHaveLength(1);
        expect(saved.filter(r => r.status === "running")).toHaveLength(1);
    });
    it("recovers an abandoned permit and rejects its late completion", async () => {
        const f = await fixture();
        await f.t.mutation(internal.mcp.reports.admission.admit, { caller: f.caller, jobs: jobs(f, 2) });
        const stale = (await rows(f)).find(r => r.status === "running")!;
        await f.t.run(ctx => ctx.db.patch("mcpReportRequests", stale._id, { startedAt: Date.now() - ASSISTANT_JOB_TIMEOUT_MS - 1 }));
        await f.t.mutation(internal.mcp.reports.admission.recover, {});
        await f.t.mutation(internal.mcp.reports.admission.finish, { requestId: stale._id, runToken: stale.runToken!, resultJson: '{"bad":true}', watermark: f.watermark });
        expect((await rows(f)).find(r => r._id === stale._id)?.status).toBe("failed");
        expect((await rows(f)).filter(r => r.status === "running")).toHaveLength(1);
    });
    it("shares the single running permit across tenants", async () => {
        const f = await fixture();
        const { seedAdminTenant } = await import("../../../tests/mcpAdminFixtures");
        const second = await seedAdminTenant(f.t, { prefix: "second_", orgId: "org_second" });
        await f.t.mutation(internal.mcp.reports.admission.admit, { caller: f.caller, jobs: jobs(f, 1) });
        await f.t.mutation(internal.mcp.reports.admission.admit, { caller: adminCaller(second.orgId, "test", "second_user_jordan"), jobs: jobs(f, 1) });
        const saved = await rows(f);
        expect(saved.filter(r => r.status === "running")).toHaveLength(1);
        expect(saved.filter(r => r.status === "waiting")).toHaveLength(1);
    });
    it("a spent allowance queues nothing and leaves the web's budget available", async () => {
        const f = await fixture();
        await f.t.run(ctx => ctx.db.insert("mcpReportRequests", { tenantId: f.tenantId, userId: f.adminId, key: "allowance:2026-11-09", report: "allowance", kind: "allowance", paramsJson: "{}", status: "ready", createdAt: Date.now(), expiresAt: Date.now() + 86400000, runCount: ASSISTANT_DAILY_RUN_ALLOWANCE }));
        const result = await f.t.mutation(internal.mcp.reports.admission.admit, { caller: f.caller, jobs: jobs(f, 1) });
        expect(result.reason).toBe("assistant_daily_allowance_spent");
        expect((await rows(f)).filter(r => r.kind === "job")).toHaveLength(0);
        const web = await f.adminWeb.mutation(api.analytics.reports.request, { reportId: "revenue.metrics", filters: {}, range: { kind: "preset", preset: "last_month" }, timeZone: "America/Tegucigalpa" });
        expect(web).toBeDefined();
        expect((await f.t.run(ctx => ctx.db.query("analyticsResults").take(5)))[0].status).toBe("pending");
    });
    it("refuses a closer before reading or queueing", async () => {
        const f = await fixture();
        await expect(f.t.action(internal.mcp.reports.tools.numbers, { caller: adminCaller(f.orgId, "test", "user_alex"), metrics: ["calls_held"], range: { kind: "preset", preset: "today" } })).rejects.toThrow("role");
        expect(await rows(f)).toHaveLength(0);
    });
    it("refuses oversized cells before querying metrics or admitting jobs", async () => {
        const f = await fixture();
        await expect(f.t.action(internal.mcp.reports.tools.numbers, { caller: f.caller, metrics: ["calls_held"], groupBy: "day", compareTo: "previous_period", range: { kind: "custom", startDate: "2026-01-01", endDateInclusive: "2026-03-01" } })).rejects.toThrow("60");
        expect(await rows(f)).toHaveLength(0);
    });
    it("reads fresh web answers without touching the row or creating assistant jobs", async () => {
        const f = await fixture();
        const request = { kind: "report" as const, report: "booked_vs_sold" as const, range: { kind: "preset" as const, preset: "last_month" as const } };
        const plan: Prepared = JSON.parse(await f.t.query(internal.mcp.reports.planning.prepare, { caller: f.caller, request }));
        const job = plan.inputs[0].job!;
        const id = await f.t.run(async (ctx) => {
            const payloadId = await ctx.db.insert("analyticsPayloads", { tenantId: f.tenantId, json: '{"rows":[],"totals":{},"isPaymentDataTruncated":false}' });
            return ctx.db.insert("analyticsResults", { tenantId: f.tenantId, reportId: job.report, argsKey: analyticsArgsKey({ filters: JSON.parse(job.filtersJson), range: job.range, day: { timeZone: job.window.timeZone, dayStartHour: 1 } }), filtersJson: job.filtersJson, range: job.range, timeZone: job.window.timeZone, dayStartHour: 1, status: "ready", payloadId, answer: { startDate: job.window.startDate, endDateInclusive: job.window.endDateInclusive, watermark: f.watermark, completedAt: Date.now() }, lastRequestedAt: 123 });
        });
        const before = await f.t.run(ctx => ctx.db.get("analyticsResults", id));
        const result = await f.t.action(internal.mcp.reports.tools.report, { caller: f.caller, report: "booked_vs_sold", range: request.range });
        expect(result.status).toBe("ready");
        expect(await rows(f)).toHaveLength(0);
        expect(await f.t.run(ctx => ctx.db.get("analyticsResults", id))).toEqual(before);
    });
});
describe("report action results", () => {
    it("a cold call returns pending within eight seconds without numbers", async () => {
        const f = await fixture();
        const { analyticsPool } = await import("../../analytics/pool");
        const spy = vi.spyOn(analyticsPool, "enqueueAction").mockImplementation(async () => "test-work" as import("@convex-dev/workpool").WorkId);
        const promise = f.t.action(internal.mcp.reports.tools.report, { caller: f.caller, report: "team", range: { kind: "preset", preset: "last_month" } });
        let result: Record<string, unknown> | undefined;
        void promise.then(value => { result = value; });
        for (let i = 0; i < 81 && !result; i++)
            await vi.advanceTimersByTimeAsync(100);
        expect(result?.status).toBe("pending");
        expect(result?.retryAfterSeconds).toBe(3);
        expect(result).not.toHaveProperty("panels");
        expect(result).not.toHaveProperty("rows");
        expect((await rows(f)).filter(r => r.kind === "job")).toHaveLength(3);
        spy.mockRestore();
    });
    it("a truncated warehouse input suppresses a comparison's delta", async () => {
        const f = await fixture();
        const request = { kind: "numbers" as const, metrics: ["calls_held" as const], range: { kind: "preset" as const, preset: "last_month" as const }, compareTo: "previous_period" as const };
        const plan: Prepared = JSON.parse(await f.t.query(internal.mcp.reports.planning.prepare, { caller: f.caller, request }));
        await f.t.run(async (ctx) => {
            for (const [index, input] of plan.inputs.entries()) {
                const job = input.job!;
                await ctx.db.insert("mcpReportRequests", { tenantId: f.tenantId, userId: f.adminId, key: job.key, report: job.report, kind: "job", paramsJson: JSON.stringify(job), status: "ready", resultJson: JSON.stringify({ rows: [{ id: "calls_held", value: 4, unit: "count", period: "total", group: null }], partial: index === 0 }), watermark: f.watermark, createdAt: Date.now(), expiresAt: Date.now() + 3600000 });
            }
        });
        const { kind: _kind, ...args } = request;
        const result = await f.t.action(internal.mcp.reports.tools.numbers, { caller: f.caller, ...args });
        expect(result.status).toBe("ready");
        expect(result.isPartial).toBe(true);
        expect((result.rows as Array<{
            periods: Array<{
                metrics: unknown[];
            }>;
        }>)[0].periods[0].metrics[0]).toMatchObject({ value: null, delta: null, nullReason: "incomplete_input" });
    });
    it("expires assistant answers after the next sync", async () => {
        const f = await fixture();
        const requested = jobs(f, 1);
        await f.t.mutation(internal.mcp.reports.admission.admit, { caller: f.caller, jobs: requested });
        await advanceJob(f);
        const row = (await rows(f)).find(r => r.kind === "job")!;
        expect(row.status).toBe("ready");
        const sync = await f.t.run(ctx => ctx.db.query("analyticsSync").first());
        await f.t.run(ctx => ctx.db.patch("analyticsSync", sync!._id, { watermark: f.watermark + 1000 }));
        const request = { kind: "report" as const, report: "team" as const, range: { kind: "preset" as const, preset: "last_month" as const } };
        const plan: Prepared = JSON.parse(await f.t.query(internal.mcp.reports.planning.prepare, { caller: f.caller, request }));
        expect(plan.syncWatermark).toBe(f.watermark + 1000);
        expect(plan.inputs[0].job?.key).not.toBe(row.key);
        const states = JSON.parse(await f.t.query(internal.mcp.reports.planning.jobStates, { caller: f.caller, jobs: plan.inputs.flatMap(i => i.job ? [i.job] : []) }));
        expect(states.every((s: {
            status: string;
        }) => s.status === "pending")).toBe(true);
    });
});
it("runs through the real shared pool and releases only after completion", async () => {
    const f = await fixture();
    await f.t.mutation(internal.mcp.reports.admission.admit, { caller: f.caller, jobs: jobs(f, 2) });
    for (let i = 0; i < 50; i++) {
        await vi.advanceTimersByTimeAsync(100);
        await f.t.finishInProgressScheduledFunctions();
        const saved = await rows(f);
        expect(saved.filter(r => r.status === "running").length).toBeLessThanOrEqual(1);
        if (saved.filter(r => r.kind === "job" && r.status === "ready").length === 2)
            break;
    }
    expect((await rows(f)).filter(r => r.kind === "job" && r.status === "ready")).toHaveLength(2);
    expect(await f.t.run(ctx => ctx.db.query("analyticsResults").take(5))).toHaveLength(0);
});

it("caps cold admissions at six jobs per tenant per minute", async () => {
    const f = await fixture();
    const requested = Array.from({ length: 7 }, (_, index) => ({ ...jobs(f, 1)[0], key: `minute:${index}` }));
    for (let batch = 0; batch < 2; batch++) {
        await f.t.mutation(internal.mcp.reports.admission.admit, { caller: f.caller, jobs: requested.slice(0, (batch + 1) * 3) });
        for (let i = 0; i < 3; i++) await advanceJob(f);
    }
    const refused = await f.t.mutation(internal.mcp.reports.admission.admit, { caller: f.caller, jobs: requested });
    expect(refused.reason).toBe("assistant_minute_allowance_spent");
    expect((await rows(f)).filter(r => r.kind === "job")).toHaveLength(6);
    vi.setSystemTime(Date.now() + 60001);
    await f.t.mutation(internal.mcp.reports.admission.admit, { caller: f.caller, jobs: requested });
    expect((await rows(f)).filter(r => r.kind === "job")).toHaveLength(7);
    expect((await rows(f)).find(r => r.kind === "allowance")?.runCount).toBe(7);
});
