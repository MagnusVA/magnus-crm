import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { businessDayFixture } from "../tests/businessDayFixtures";
import { businessDayStart, BUSINESS_DAY_REBUILD_MESSAGE } from "../lib/businessDay";
import { deriveOverviewRange } from "./dashboard/overviewRange";
import { getPeriodKey, getPeriodsInRange } from "./reporting/lib/periodBucketing";
import { assertBusinessDayReady, markLeadGenBusinessDayDirty } from "./lib/businessDayRebuildState";

afterEach(() => vi.useRealTimers());
const changed = { timeZone: "UTC", dayStartHour: 0 };
const range = { kind: "custom" as const, startBusinessDate: "2026-09-30", endBusinessDateInclusive: "2026-10-02" };

describe("tenant business days", () => {
  it("starts newly invited tenants ready without unlocking existing tenants", async () => {
    const { t, admin } = await businessDayFixture();
    const tenantId = await t.mutation(internal.admin.tenantsMutations.insertTenant, {
      companyName: "New tenant", contactEmail: "new@example.com", workosOrgId: "org_new",
      createdBy: "system-admin", inviteTokenHash: "new-invite", inviteExpiresAt: Date.now() + 10000,
    });
    await t.run(ctx => ctx.db.insert("users", {
      tenantId, workosUserId: "user_new", email: "new@example.com", role: "tenant_admin", isActive: true,
    }));
    const newAdmin = t.withIdentity({ subject: "user_new", org_id: "org_new" });
    expect(await t.run(ctx => ctx.db.get("tenants", tenantId))).toMatchObject({ businessDayAppliedVersion: 0 });
    expect(await newAdmin.query(api.tenants.getCurrentTenant, {})).toMatchObject({ businessDayReady: true, leadGenBusinessDayReady: true });
    await expect(newAdmin.query(api.operations.salesCallsDashboard.getSalesCallsDashboard, { range })).resolves.toBeDefined();
    expect(await admin.query(api.tenants.getCurrentTenant, {})).toMatchObject({ businessDayReady: false });
  });

  it.each(["booked-calls", "qualifications"] as const)("allows %s dashboard and export requests without meeting readiness", async (reportKind) => {
    const { t, admin } = await businessDayFixture();
    // Both before cutover and during a settings rebuild, these readers use source records.
    for (const rebuilding of [false, true]) {
      if (rebuilding) await admin.mutation(api.businessDays.updateBusinessDay, { setting: changed });
      for (const purpose of ["dashboard", "export"] as const) {
        const args = { reportKind, range, requestToken: `${reportKind}-${purpose}-${rebuilding}` };
        const result = purpose === "dashboard"
          ? await admin.mutation(api.operations.reports.jobs.requestDashboardReport, args)
          : await admin.mutation(api.operations.reports.jobs.requestExport, { ...args, format: "summary_csv" });
        expect(await t.run(ctx => ctx.db.get("operationsReportJobs", result.jobId))).toMatchObject({ reportKind, purpose, status: "queued" });
        await admin.mutation(api.operations.reports.jobs.cancelReport, { jobId: result.jobId });
      }
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("shows rebuilding Overview sections only for the buckets that are unavailable", async () => {
    const { t, admin, tenantId } = await businessDayFixture();
    const overview = () => admin.query(api.dashboard.overview.getOverviewDashboard, { range });
    const rebuilding = { status: "rebuilding", data: null, message: BUSINESS_DAY_REBUILD_MESSAGE, errorCode: null };
    expect(await overview()).toMatchObject({
      phoneCloserOperations: rebuilding,
      leadGen: { status: "ready", data: { totalSubmissions: 3 } },
      topOrigins: { status: "ready" },
    });
    await t.mutation(internal.businessDays.beginBusinessDayCutover, { tenantId, rebuildLeadGen: false });
    expect(await overview()).toMatchObject({ phoneCloserOperations: rebuilding, leadGen: { status: "ready" }, topOrigins: { status: "ready" } });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await overview()).toMatchObject({ phoneCloserOperations: { status: "ready" } });
    const rebuildId = await admin.mutation(api.businessDays.updateBusinessDay, { setting: changed });
    expect(await overview()).toMatchObject({ phoneCloserOperations: rebuilding, leadGen: rebuilding, topOrigins: rebuilding });
    await t.mutation(internal.businessDays.failRebuild, { rebuildId, error: "Interrupted settings rebuild" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await overview()).toMatchObject({ phoneCloserOperations: rebuilding, leadGen: rebuilding, topOrigins: rebuilding });
    await admin.mutation(api.businessDays.retryBusinessDayRebuild, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await overview()).toMatchObject({ phoneCloserOperations: { status: "ready" }, leadGen: { status: "ready", data: { totalSubmissions: 3 } }, topOrigins: { status: "ready" } });
  });

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
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(ctx => ctx.db.get("businessDayRebuilds", id))).toMatchObject({ state: "done" });
  });
  it("rebuilds projections and all three lead gen tables, audits cleanly and is idempotent", async () => {
    const { t, admin, tenantId, meetingId } = await businessDayFixture();
    const before = await admin.mutation(api.operations.reports.jobs.requestDashboardReport, { reportKind: "lead-gen", range, requestToken: "before" });
    const id = await admin.mutation(api.businessDays.updateBusinessDay, { setting: changed });
    expect((await t.run(ctx => ctx.db.get("operationsReportJobs", before.jobId)))?.status).toBe("canceled");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
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
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const second = await totals();
    const counters = (rows: typeof first.daily | typeof first.origin | typeof first.team) => rows.map(({ dayKey, submissions, uniqueProspectsSubmitted }) => ({ dayKey, submissions, uniqueProspectsSubmitted }));
    for (const key of ["daily", "origin", "team"] as const) expect(counters(second[key])).toEqual(counters(first[key]));
    expect(await t.run(ctx => ctx.db.query("businessDayRebuildRows").take(5))).toEqual([]);
    expect(await t.run(ctx => ctx.db.query("businessDayRebuildSeen").take(5))).toEqual([]);
    const after = await admin.mutation(api.operations.reports.jobs.requestDashboardReport, { reportKind: "lead-gen", range, requestToken: "after" });
    expect(after.requestKey).not.toBe(before.requestKey);
  });
  it("fails and cleans a corrected snapshot, then retries from the corrected source", async () => {
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
      expect(await markLeadGenBusinessDayDirty(ctx, tenantId, true)).toBe(true);
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(ctx => ctx.db.get("businessDayRebuilds", rebuildId))).toMatchObject({ state: "failed", error: expect.stringContaining("corrected") });
    expect(await t.run(ctx => ctx.db.query("businessDayRebuildRows").take(1))).toEqual([]);
    expect(await t.run(ctx => ctx.db.query("businessDayRebuildSeen").take(1))).toEqual([]);
    await admin.mutation(api.businessDays.retryBusinessDayRebuild, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(ctx => ctx.db.get("businessDayRebuilds", rebuildId))).toMatchObject({ state: "done", pass: 2 });
    expect(await admin.query(api.leadGen.reconciliation.auditAggregateRange, { startTimestamp: Date.parse("2026-10-01T00:00Z"), endTimestamp: Date.parse("2026-10-03T00:00Z") - 1 })).toMatchObject({ submissionDelta: 0, uniqueProspectDelta: 0, duplicateDelta: 0, activeSubmissions: 2 });
  });
  it("fails a stalled projection wait within its retry budget and keeps reports blocked", async () => {
    const { t, admin, closer, meetingId } = await businessDayFixture();
    await expect(admin.mutation(api.businessDays.retryBusinessDayRebuild, {})).rejects.toThrow("No failed");
    const rebuildId = await admin.mutation(api.businessDays.updateBusinessDay, { setting: changed });
    await expect(admin.mutation(api.businessDays.retryBusinessDayRebuild, {})).rejects.toThrow(BUSINESS_DAY_REBUILD_MESSAGE);
    // Model a queued obligation whose worker never runs, without modifying Workpool.
    await t.run(async ctx => {
      const projection = await ctx.db.query("meetingProjections").withIndex("by_meetingId", q => q.eq("meetingId", meetingId)).unique();
      await ctx.db.patch("meetingProjections", projection!._id, { status: "queued" });
      await ctx.db.patch("businessDayRebuilds", rebuildId, { phase: "drain" });
    });
    const delays = [];
    for (let attempt = 0; attempt < 120; attempt++) {
      delays.push(await t.mutation(internal.businessDays.rebuildStep, { rebuildId }));
    }
    expect(delays.slice(0, 7)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(delays.at(-1)).toBe(30000);
    // The already scheduled action records the terminal error and schedules no retry.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(ctx => ctx.db.get("businessDayRebuilds", rebuildId))).toMatchObject({ state: "failed", projectionWaitAttempts: 120 });
    expect(await admin.query(api.tenants.getCurrentTenant, {})).toMatchObject({ businessDayRebuild: { state: "failed", error: expect.stringContaining("120 checks") } });
    await expect(admin.mutation(api.operations.reports.jobs.requestExport, { reportKind: "lead-gen", range, requestToken: "failed", format: "summary_csv" })).rejects.toThrow(BUSINESS_DAY_REBUILD_MESSAGE);
    await expect(closer.mutation(api.businessDays.retryBusinessDayRebuild, {})).rejects.toThrow("Insufficient permissions");
    await expect(t.withIdentity({ subject: "user_admin", org_id: "org_other" }).mutation(api.businessDays.retryBusinessDayRebuild, {})).rejects.toThrow("Organization mismatch");
  });
  it("retries a failed partial swap, clears the error and reuses the version", async () => {
    const { t, admin, tenantId } = await businessDayFixture();
    const rebuildId = await admin.mutation(api.businessDays.updateBusinessDay, { setting: changed });
    for (let step = 0; step < 8; step++) {
      await t.mutation(internal.businessDays.rebuildStep, { rebuildId });
      if ((await t.run(ctx => ctx.db.get("businessDayRebuilds", rebuildId)))?.phase === "audit_lead_gen") break;
    }
    await t.mutation(internal.businessDays.failRebuild, { rebuildId, error: "Interrupted after swap" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await admin.mutation(api.businessDays.retryBusinessDayRebuild, {})).toBe(rebuildId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const job = await t.run(ctx => ctx.db.get("businessDayRebuilds", rebuildId));
    expect(job).toMatchObject({ state: "done", pass: 2, version: 1 });
    expect(job?.error).toBeUndefined();
    expect((await t.run(ctx => ctx.db.get("tenants", tenantId)))?.businessDayVersion).toBe(1);
    expect(await admin.query(api.tenants.getCurrentTenant, {})).toMatchObject({ businessDayRebuild: null });
    await expect(admin.mutation(api.businessDays.retryBusinessDayRebuild, {})).rejects.toThrow("No failed");
    expect(await t.run(ctx => ctx.db.query("businessDayRebuildRows").take(1))).toEqual([]);
    expect(await t.run(ctx => ctx.db.query("businessDayRebuildSeen").take(1))).toEqual([]);
    await admin.mutation(api.leadGen.backfills.rebuildTeamOriginStatsRange, { startDayKey: "2026-10-01", endDayKey: "2026-10-02", dryRun: false });
    expect(await admin.query(api.leadGen.reconciliation.auditTeamOriginStatsRange, { startDayKey: "2026-10-01", endDayKey: "2026-10-02" })).toMatchObject({ diffCount: 0 });
  });
  it("finishes every phase when its source tables are empty", async () => {
    const { bookingHarness } = await import("../tests/bookingHarness");
    vi.useFakeTimers();
    const { t, admin } = await bookingHarness({ transactionLimits: true });
    const rebuildId = await admin.mutation(api.businessDays.updateBusinessDay, { setting: changed });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(ctx => ctx.db.get("businessDayRebuilds", rebuildId))).toMatchObject({ state: "done", meetingsEnqueued: 0, leadGenRowsComputed: 0, leadGenDone: true });
  });

  it("blocks unapplied meeting buckets before cutover, skips lead gen, and reapplies after a setting change", async () => {
    const { t, admin, tenantId } = await businessDayFixture();
    const tenantState = () => admin.query(api.tenants.getCurrentTenant, {});
    const readMeetings = () => admin.query(api.reporting.teamPerformance.getTeamOperationsDimensions, {
      startDate: Date.parse("2026-09-30T06:00Z"), endDate: Date.parse("2026-10-03T06:00Z"),
    });
    expect(await tenantState()).toMatchObject({ businessDayReady: false, leadGenBusinessDayReady: true });
    await expect(readMeetings()).rejects.toThrow(BUSINESS_DAY_REBUILD_MESSAGE);
    for (const purpose of ["dashboard", "export"] as const) {
      const args = { reportKind: "sales-calls" as const, range, requestToken: `cutover-${purpose}` };
      await expect(purpose === "dashboard" ? admin.mutation(api.operations.reports.jobs.requestDashboardReport, args)
        : admin.mutation(api.operations.reports.jobs.requestExport, { ...args, format: "summary_csv" })).rejects.toThrow(BUSINESS_DAY_REBUILD_MESSAGE);
    }
    expect(await t.run(ctx => ctx.db.query("operationsReportJobs").take(1))).toEqual([]);
    const before = await t.run(ctx => ctx.db.query("leadGenDailyStats").take(10));
    const rebuildId = await t.mutation(internal.businessDays.beginBusinessDayCutover, { tenantId, rebuildLeadGen: false });
    await expect(t.mutation(internal.businessDays.beginBusinessDayCutover, { tenantId, rebuildLeadGen: false })).rejects.toThrow(BUSINESS_DAY_REBUILD_MESSAGE);
    expect(await tenantState()).toMatchObject({ businessDayReady: false, leadGenBusinessDayReady: true });
    await expect(admin.query(api.leadGen.reporting.getOverview, { startDayKey: "2026-09-30", endDayKey: "2026-10-02" })).resolves.toBeDefined();
    await expect(admin.query(api.leadGen.activity.getMyDaySummary, { dayKey: "2026-10-01" })).resolves.toBeDefined();
    await expect(admin.mutation(api.operations.reports.jobs.requestDashboardReport, { reportKind: "lead-gen", range, requestToken: "cutover-lead-gen" })).resolves.toBeDefined();
    expect(await t.run(ctx => markLeadGenBusinessDayDirty(ctx, tenantId))).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(ctx => ctx.db.get("businessDayRebuilds", rebuildId))).toMatchObject({ state: "done", version: 1, rebuildLeadGen: false, leadGenRowsComputed: 0, leadGenRowsSwapped: 0, leadGenAudited: 0 });
    expect(await t.run(ctx => ctx.db.query("leadGenDailyStats").take(10))).toEqual(before);
    expect(await t.run(ctx => ctx.db.get("tenants", tenantId))).toMatchObject({ businessDayVersion: 1, businessDayAppliedVersion: 1 });
    expect(await tenantState()).toMatchObject({ businessDayReady: true });
    expect(await readMeetings()).toMatchObject({ totals: { completed: 1 } });
    await expect(t.run(ctx => assertBusinessDayReady(ctx, tenantId))).resolves.toBeNull();
    await admin.mutation(api.businessDays.updateBusinessDay, { setting: changed });
    expect(await tenantState()).toMatchObject({ businessDayReady: false, leadGenBusinessDayReady: false });
    await expect(admin.query(api.leadGen.activity.getMyDaySummary, { dayKey: "2026-10-01" })).rejects.toThrow(BUSINESS_DAY_REBUILD_MESSAGE);
    await expect(admin.query(api.leadGen.reporting.getOverview, { startDayKey: "2026-09-30", endDayKey: "2026-10-02" })).rejects.toThrow(BUSINESS_DAY_REBUILD_MESSAGE);
    await expect(readMeetings()).rejects.toThrow(BUSINESS_DAY_REBUILD_MESSAGE);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await tenantState()).toMatchObject({ businessDayReady: true, leadGenBusinessDayReady: true });
    expect(await t.run(ctx => ctx.db.get("tenants", tenantId))).toMatchObject({ businessDayVersion: 2, businessDayAppliedVersion: 2 });
  });

  it("includes October 22 daytime meetings in an October 22 Honduras browser range", async () => {
    const { t, admin, tenantId, meetingId } = await businessDayFixture();
    await t.run(ctx => ctx.db.patch("meetings", meetingId, { scheduledAt: Date.parse("2026-10-22T18:00:00Z") }));
    await t.mutation(internal.businessDays.beginBusinessDayCutover, { tenantId, rebuildLeadGen: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await admin.query(api.reporting.teamPerformance.getTeamOperationsDimensions, {
      startDate: Date.parse("2026-10-22T00:00:00-06:00"), endDate: Date.parse("2026-10-23T00:00:00-06:00"),
    })).toMatchObject({ totals: { completed: 1 } });
  });

  it("catches up only newer submissions and resumes live counters after the final fence", async () => {
    const { t, admin, tenantId } = await businessDayFixture();
    const rebuildId = await admin.mutation(api.businessDays.updateBusinessDay, { setting: changed });
    for (let step = 0; step < 10; step++) {
      await t.mutation(internal.businessDays.rebuildStep, { rebuildId });
      if ((await t.run(ctx => ctx.db.get("businessDayRebuilds", rebuildId)))?.phase === "compute") break;
    }
    // Equal to the exclusive watermark: this capture belongs to the catch-up,
    // including when it commits in the same millisecond the snapshot starts.
    await admin.mutation(api.leadGen.capture.submit, { source: "instagram", rawHandleOrProfileUrl: "watermarkone", originKind: "reel", originUrlOrLabel: "https://instagram.com/reel/daytest/" });
    await t.mutation(internal.businessDays.rebuildStep, { rebuildId });
    expect(await t.run(ctx => ctx.db.get("businessDayRebuilds", rebuildId))).toMatchObject({ phase: "swap", pass: 1, leadGenRowsComputed: 4 });
    vi.setSystemTime(Date.now() + 10);
    await admin.mutation(api.leadGen.capture.submit, { source: "instagram", rawHandleOrProfileUrl: "watermarktwo", originKind: "reel", originUrlOrLabel: "https://instagram.com/reel/daytest/" });
    vi.setSystemTime(Date.now() + 10);
    for (let step = 0; step < 20; step++) {
      await t.mutation(internal.businessDays.rebuildStep, { rebuildId });
      if ((await t.run(ctx => ctx.db.get("businessDayRebuilds", rebuildId)))?.leadGenDone) break;
    }
    expect(await t.run(ctx => ctx.db.get("businessDayRebuilds", rebuildId))).toMatchObject({ state: "running", phase: "drain", pass: 1, catchUpPasses: 1, leadGenRowsComputed: 6, leadGenDone: true });
    await admin.mutation(api.leadGen.capture.submit, { source: "instagram", rawHandleOrProfileUrl: "watermarkthree", originKind: "reel", originUrlOrLabel: "https://instagram.com/reel/daytest/" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(ctx => ctx.db.get("businessDayRebuilds", rebuildId))).toMatchObject({ state: "done", pass: 1, leadGenRowsComputed: 6 });
    expect(await admin.query(api.leadGen.reconciliation.auditAggregateRange, { startTimestamp: Date.parse("2026-09-30T00:00Z"), endTimestamp: Date.now() })).toMatchObject({ submissionDelta: 0, uniqueProspectDelta: 0, duplicateDelta: 0, activeSubmissions: 6 });
    expect(await admin.query(api.leadGen.reconciliation.auditTeamOriginStatsRange, { startDayKey: "2026-09-30", endDayKey: "2026-10-04" })).toMatchObject({ diffCount: 0 });
    expect(await t.run(ctx => ctx.db.get("tenants", tenantId))).toMatchObject({ businessDayAppliedVersion: 1 });
  });

  it("fails after five catch-up passes under continuous captures and cleans staging", async () => {
    const { t, admin, tenantId } = await businessDayFixture();
    const rebuildId = await admin.mutation(api.businessDays.updateBusinessDay, { setting: changed });
    let captures = 0;
    for (let step = 0; step < 40; step++) {
      const job = await t.run(ctx => ctx.db.get("businessDayRebuilds", rebuildId));
      if (job?.state === "failed") break;
      if (job?.phase === "audit_lead_gen") {
        vi.setSystemTime(Date.now() + 10);
        await admin.mutation(api.leadGen.capture.submit, { source: "instagram", rawHandleOrProfileUrl: `busywatermark${captures++}`, originKind: "reel", originUrlOrLabel: "https://instagram.com/reel/daytest/" });
        vi.setSystemTime(Date.now() + 10);
      }
      await t.action(internal.businessDays.runRebuild, { rebuildId });
    }
    expect(captures).toBe(6);
    expect(await t.run(ctx => ctx.db.get("businessDayRebuilds", rebuildId))).toMatchObject({ state: "failed", catchUpPasses: 5, pass: 1, leadGenRowsComputed: 9, error: expect.stringContaining("5 catch-up passes") });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(ctx => ctx.db.query("businessDayRebuildRows").take(1))).toEqual([]);
    expect(await t.run(ctx => ctx.db.query("businessDayRebuildSeen").take(1))).toEqual([]);
    await expect(t.run(ctx => assertBusinessDayReady(ctx, tenantId))).rejects.toThrow(BUSINESS_DAY_REBUILD_MESSAGE);
  });

});
