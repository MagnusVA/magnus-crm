import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { businessDayFixture } from "../tests/businessDayFixtures";
import { businessDayStart, BUSINESS_DAY_REBUILD_MESSAGE } from "../lib/businessDay";
import { deriveOverviewRange } from "./dashboard/overviewRange";
import { getPeriodKey, getPeriodsInRange } from "./reporting/lib/periodBucketing";
import { markLeadGenBusinessDayDirty } from "./lib/businessDayRebuildState";

afterEach(() => vi.useRealTimers());
const changed = { timeZone: "UTC", dayStartHour: 0 };
const range = { kind: "custom" as const, startBusinessDate: "2026-09-30", endBusinessDateInclusive: "2026-10-02" };

describe("tenant business days", () => {
  it("keys evening meetings to their business date and aligns overview operations and Slack", async () => {
    const { t, meetingId } = await businessDayFixture();
    const projection = await t.run(ctx => ctx.db.query("meetingProjections").withIndex("by_meetingId", q => q.eq("meetingId", meetingId)).unique());
    expect(projection?.contribution?.dayKey).toBe("2026-09-30");
    const window = deriveOverviewRange({ kind: "preset", preset: "today" }, Date.parse("2026-10-01T02:00Z"));
    expect(window.operationsStartDate).toBe(Date.parse("2026-09-30T07:00Z"));
    expect(window.operationsStartDate).toBe(window.slackWindowStart);
    const alternate = deriveOverviewRange({ kind: "preset", preset: "this_week" }, Date.parse("2026-10-25T16:00Z"), changed);
    expect(alternate.startBusinessDate).toBe("2026-10-19");
    expect(alternate.operationsStartDate).toBe(businessDayStart("2026-10-19", changed));
  });
  it("uses business day, Monday week and month keys for revenue", async () => {
    const { admin } = await businessDayFixture();
    for (const [granularity, key] of [["day", "2026-09-30"], ["week", "2026-W40"], ["month", "2026-09"]] as const) {
      const result = await admin.query(api.reporting.revenueTrend.getRevenueTrend, { startDate: Date.parse("2026-09-29T07:00Z"), endDate: Date.parse("2026-10-03T07:00Z"), granularity });
      expect(result.trend.filter(row => row.revenueMinor > 0)).toMatchObject([{ periodKey: key, revenueMinor: 10000 }]);
    }
    const ny = { timeZone: "America/New_York", dayStartHour: 1 };
    expect(getPeriodsInRange(Date.parse("2026-03-08T06:00Z"), Date.parse("2026-03-09T05:00Z"), "day", ny)).toEqual([{ key: "2026-03-08", start: Date.parse("2026-03-08T06:00Z"), end: Date.parse("2026-03-09T05:00Z") }]);
    expect(getPeriodKey(Date.parse("2026-10-01T02:00Z"), "month", changed)).toBe("2026-10");
  });
  it("checks role, organization, zone and hour without accepting a tenant argument", async () => {
    const { t, admin, closer, tenantId } = await businessDayFixture();
    await expect(closer.mutation(api.businessDays.updateBusinessDay, { setting: changed })).rejects.toThrow("Insufficient permissions");
    await expect(t.withIdentity({ subject: "user_admin", org_id: "org_other" }).mutation(api.businessDays.updateBusinessDay, { setting: changed })).rejects.toThrow("Organization mismatch");
    for (const setting of [{ timeZone: "No/Zone", dayStartHour: 1 }, { timeZone: "UTC", dayStartHour: 24 }, { timeZone: "UTC", dayStartHour: 0.5 }]) await expect(admin.mutation(api.businessDays.updateBusinessDay, { setting })).rejects.toThrow();
    expect((await t.run(ctx => ctx.db.get("tenants", tenantId)))?.businessDayVersion).toBeUndefined();
    const id = await admin.mutation(api.businessDays.updateBusinessDay, { setting: changed });
    expect(await t.run(ctx => ctx.db.get("businessDayRebuilds", id))).toMatchObject({ tenantId, state: "running", version: 1 });
    expect(await admin.query(api.tenants.getCurrentTenant, {})).toMatchObject({ businessDay: changed, businessDayVersion: 1, businessDayRebuild: { state: "running" } });
    await expect(admin.mutation(api.businessDays.updateBusinessDay, { setting: changed })).rejects.toThrow(BUSINESS_DAY_REBUILD_MESSAGE);
    for (const purpose of ["dashboard", "export"] as const) {
      const request = { reportKind: "sales-calls" as const, range, requestToken: purpose };
      await expect(purpose === "dashboard" ? admin.mutation(api.operations.reports.jobs.requestDashboardReport, request) : admin.mutation(api.operations.reports.jobs.requestExport, { ...request, format: "summary_csv" })).rejects.toThrow(BUSINESS_DAY_REBUILD_MESSAGE);
    }
    expect(await t.run(ctx => ctx.db.query("operationsReportJobs").take(5))).toEqual([]);
    await t.finishAllScheduledFunctions(vi.runAllTimers, 100);
    expect(await t.run(ctx => ctx.db.get("businessDayRebuilds", id))).toMatchObject({ state: "done" });
  });
  it("rebuilds projections and all three lead gen tables, audits cleanly and is idempotent", async () => {
    const { t, admin, tenantId, meetingId } = await businessDayFixture();
    const before = await admin.mutation(api.operations.reports.jobs.requestDashboardReport, { reportKind: "lead-gen", range, requestToken: "before" });
    const id = await admin.mutation(api.businessDays.updateBusinessDay, { setting: changed });
    expect((await t.run(ctx => ctx.db.get("operationsReportJobs", before.jobId)))?.status).toBe("canceled");
    await t.finishAllScheduledFunctions(vi.runAllTimers, 100);
    const job = await t.run(ctx => ctx.db.get("businessDayRebuilds", id));
    expect(job).toMatchObject({ state: "done", meetingsEnqueued: 1, leadGenRowsComputed: 4, leadGenDone: true, meetingsAsserted: 1, sourcesAsserted: 1 });
    const projection = await t.run(ctx => ctx.db.query("meetingProjections").withIndex("by_meetingId", q => q.eq("meetingId", meetingId)).unique());
    expect(projection?.contribution?.dayKey).toBe("2026-10-01");
    const audit = await admin.query(api.leadGen.reconciliation.auditAggregateRange, { startTimestamp: Date.parse("2026-09-30T00:00Z"), endTimestamp: Date.parse("2026-10-03T00:00Z") - 1 });
    expect(audit).toMatchObject({ submissionDelta: 0, uniqueProspectDelta: 0, duplicateDelta: 0, activeSubmissions: 3, activeUniqueProspects: 2 });
    expect(await admin.query(api.leadGen.reconciliation.auditTeamOriginStatsRange, { startDayKey: "2026-09-30", endDayKey: "2026-10-02" })).toMatchObject({ diffCount: 0 });
    const totals = () => t.run(async ctx => ({ daily: await ctx.db.query("leadGenDailyStats").withIndex("by_tenantId_and_dayKey", q => q.eq("tenantId", tenantId)).take(20), origin: await ctx.db.query("leadGenOriginStats").withIndex("by_tenantId_and_dayKey", q => q.eq("tenantId", tenantId)).take(20), team: await ctx.db.query("leadGenTeamOriginStats").withIndex("by_tenantId_and_dayKey", q => q.eq("tenantId", tenantId)).take(20) }));
    const first = await totals();
    expect(first.daily.reduce((sum, row) => sum + row.submissions, 0)).toBe(3);
    expect(first.origin.reduce((sum, row) => sum + row.uniqueProspectsSubmitted, 0)).toBe(2);
    await admin.mutation(api.businessDays.updateBusinessDay, { setting: changed });
    await t.finishAllScheduledFunctions(vi.runAllTimers, 100);
    const second = await totals();
    const counters = (rows: typeof first.daily | typeof first.origin | typeof first.team) => rows.map(({ dayKey, submissions, uniqueProspectsSubmitted }) => ({ dayKey, submissions, uniqueProspectsSubmitted }));
    for (const key of ["daily", "origin", "team"] as const) expect(counters(second[key])).toEqual(counters(first[key]));
    expect(await t.run(ctx => ctx.db.query("businessDayRebuildRows").take(5))).toEqual([]);
    expect(await t.run(ctx => ctx.db.query("businessDayRebuildSeen").take(5))).toEqual([]);
    const after = await admin.mutation(api.operations.reports.jobs.requestDashboardReport, { reportKind: "lead-gen", range, requestToken: "after" });
    expect(after.requestKey).not.toBe(before.requestKey);
  });
  it("restarts the lead gen compute pass when a capture or correction changes its source", async () => {
    const { t, admin, tenantId, submissionIds } = await businessDayFixture();
    const rebuildId = await admin.mutation(api.businessDays.updateBusinessDay, { setting: changed });
    // Pause between compute and swap, without letting the scheduled driver run.
    for (let step = 0; step < 8; step++) {
      await t.mutation(internal.businessDays.rebuildStep, { rebuildId });
      const job = await t.run(ctx => ctx.db.get("businessDayRebuilds", rebuildId));
      if (job?.phase === "swap") break;
    }
    await t.run(async ctx => {
      await ctx.db.patch("leadGenSubmissions", submissionIds[1], { voidedAt: Date.now() });
      expect(await markLeadGenBusinessDayDirty(ctx, tenantId)).toBe(true);
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers, 100);
    expect(await t.run(ctx => ctx.db.get("businessDayRebuilds", rebuildId))).toMatchObject({ state: "done", pass: 2 });
    expect(await admin.query(api.leadGen.reconciliation.auditAggregateRange, { startTimestamp: Date.parse("2026-10-01T00:00Z"), endTimestamp: Date.parse("2026-10-03T00:00Z") - 1 })).toMatchObject({ submissionDelta: 0, uniqueProspectDelta: 0, duplicateDelta: 0, activeSubmissions: 2 });
  });
});
