import { afterEach, describe, it, expect, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import { adminFixture, adminCaller } from "../../../tests/mcpAdminFixtures";
import { REPORT_PANELS } from "./catalog";
import { resolveAnalyticsRange } from "../../../lib/analyticsRange";
import { gatewayAnswerBytes } from "../../../lib/assistantReportMerge";
import { readGoals } from "./operations";
async function fixture() {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-09T18:00:00Z"));
    const f = await adminFixture();
    await f.t.run(ctx => ctx.db.patch("tenants", f.tenantId, { businessDayAppliedVersion: 0 }));
    return { ...f, caller: adminCaller(f.orgId) };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("live page adapter parity", () => {
    for (const report of Object.keys(REPORT_PANELS) as Array<keyof typeof REPORT_PANELS>)
        it(`serves ${report}'s full live breakdown`, async () => {
            const f = await fixture();
            const result = await f.t.action(internal.mcp.reports.tools.report, { caller: f.caller, report });
            expect(result.status, JSON.stringify(result)).toBe("ready");
            expect((result.panels as Array<{
                id: string;
                scope: string;
            }>).map((p: {
                id: string;
            }) => p.id)).toEqual(REPORT_PANELS[report]);
            expect(gatewayAnswerBytes(result)).toBeLessThanOrEqual(12288);
            if (report === "pipeline")
                expect((result.panels as Array<{
                    id: string;
                    scope: string;
                }>).slice(0, 2).every((p: {
                    scope: string;
                }) => p.scope === "current_state_ignores_range")).toBe(true);
        });
    it("uses identical raw payment builders and preserves currencies in numbers", async () => {
        const f = await fixture();
        const range = resolveAnalyticsRange({ kind: "custom", startDate: "2026-11-09", endDateInclusive: "2026-11-09" }, { timeZone: "America/Tegucigalpa", dayStartHour: 1 }, Date.now());
        const programId = await f.t.run(ctx => ctx.db.insert("tenantPrograms", { tenantId: f.tenantId, name: "Test", normalizedName: "test", createdAt: 0, updatedAt: 0, createdByUserId: f.adminId }));
        await f.t.run(async (ctx) => { for (const [currency, paymentType, amountMinor] of [["USD", "pif", 10000], ["USD", "deposit", 2000], ["EUR", "pif", 5000]] as const)
            await ctx.db.insert("paymentRecords", { tenantId: f.tenantId, attributedCloserId: f.closerId, recordedByUserId: f.closerId, programId, programName: "Test", currency, paymentType, amountMinor, status: "verified", origin: "closer_meeting", recordedAt: Date.now() }); });
        const raw = JSON.parse(await f.t.query(internal.mcp.reports.read.panel, { caller: f.caller, id: "revenue.metrics", filters: {}, range }));
        const page = await f.adminWeb.query(api.reporting.revenue.getRevenueMetrics, { startDate: range.fromMs, endDate: range.toMs });
        expect(raw).toEqual(page);
        const numbers = await f.t.action(internal.mcp.reports.tools.numbers, { caller: f.caller, metrics: ["final_cash", "deposits"], range: { kind: "preset", preset: "today" } });
        expect(numbers.status).toBe("ready");
        const metrics = (numbers.rows as Array<{
            periods: Array<{
                metrics: Array<{
                    id: string;
                    currency: string;
                    value: number;
                }>;
            }>;
        }>)[0].periods[0].metrics;
        expect(metrics.filter((r: {
            id: string;
        }) => r.id === "final_cash").map((r: {
            currency: string;
            value: number;
        }) => [r.currency, r.value])).toEqual([["USD", 10000], ["EUR", 5000]]);
        const report = await f.t.action(internal.mcp.reports.tools.report, { caller: f.caller, report: "revenue" });
        expect(report.status).toBe("ready");
        expect((report.panels as Array<{
            data: {
                revenue: {
                    finalRevenueMinor: unknown;
                };
            };
        }>)[0].data.revenue.finalRevenueMinor).toEqual({ value: null, nullReason: "mixed_currencies" });
    });
    it("assembles Goals from the page's same three inputs", async () => {
        const f = await fixture();
        const assembled = await f.t.run(ctx => readGoals(ctx, f.tenantId));
        const directory = await f.adminWeb.query(api.team.directory.getDirectory, {});
        expect(assembled.directory).toEqual(directory);
        const range = { kind: "custom" as const, startBusinessDate: "2026-10-10", endBusinessDateInclusive: "2026-11-08" };
        expect(assembled.qualifications).toEqual(await f.adminWeb.query(api.operations.qualificationsDashboard.getQualificationsDashboard, { range }));
        expect(assembled.booked).toEqual(await f.adminWeb.query(api.operations.bookedCallsDashboard.getBookedCallsDashboard, { range }));
    });
});
