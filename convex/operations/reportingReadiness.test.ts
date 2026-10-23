import { afterEach, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import { book, enrollmentHarness } from "../../tests/enrollmentFixtures";
import { deriveOverviewRange } from "../dashboard/overviewRange";
import { getPhoneCloserOperationsOverviewSection } from "../dashboard/overviewOperations";
import { readSourcePage } from "./reports/readers";
import { requireReportingReady } from "./reportingReadiness";

afterEach(() => vi.useRealTimers());

it.each(["empty", "unverified", "version2"] as const)(
  "all five reports enforce readiness for a %s tenant using meeting source rows",
  async (state) => {
    const h = await enrollmentHarness();
    if (state !== "empty") await book(h, `readiness-${state}`);
    if (state === "version2") {
      await h.t.run((ctx) => ctx.db.patch("tenants", h.tenantId, { meetingProjectionVersion: 2 }));
    }
    const startDate = Date.parse("2026-10-01T00:00:00Z");
    const endDate = Date.parse("2026-10-02T00:00:00Z");
    const range = {
      kind: "custom" as const,
      startBusinessDate: "2026-10-01",
      endBusinessDateInclusive: "2026-10-01",
    };
    const reports = [
      () => h.admin.query(api.reporting.pipelineHealth.getSchedulingShowRateByOperationsDimensions, {
        startDayKey: "2026-10-01", endDayKeyExclusive: "2026-10-02",
      }),
      () => h.admin.query(api.reporting.teamPerformance.getTeamOperationsDimensions, { startDate, endDate }),
      () => h.admin.query(api.operations.salesCallsDashboard.getSalesCallsDashboard, { range }),
      () => h.t.run((ctx) => getPhoneCloserOperationsOverviewSection(
        ctx, h.tenantId, deriveOverviewRange(range, Date.now()),
      )),
      () => h.t.run((ctx) => readSourcePage(ctx, {
        tenantId: h.tenantId, reportKind: "sales-calls", sourceKey: "sales_meeting_stats",
        startTimestamp: startDate, endTimestampExclusive: endDate,
        startDayKey: "2026-10-01", endDayKeyExclusive: "2026-10-02",
        sourceFilter: "all", teamId: null, workerId: null, cursor: null,
      })),
    ];
    if (state === "unverified") {
      for (const report of reports) {
        await expect(report()).rejects.toThrow("Reporting rebuild has not been verified");
      }
    } else {
      for (const report of reports) await expect(report()).resolves.toBeDefined();
      // The version 2 reports actually read the projected booking; these
      // tenants have no legacy stats fixture at all.
      const scheduled = state === "version2" ? 1 : 0;
      expect(await reports[0]()).toMatchObject({ scheduled });
      expect(await reports[1]()).toMatchObject({ totals: { scheduled } });
      expect(await reports[2]()).toMatchObject({ stats: { totalCalls: scheduled } });
      expect(await reports[3]()).toMatchObject({ data: { totals: { scheduled } } });
      expect(await reports[4]()).toMatchObject({ page: scheduled ? [{ count: 1 }] : [] });
    }
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  },
);

it("does not use another tenant's meetings to block an empty tenant", async () => {
  const h = await enrollmentHarness();
  const { meetingId } = await book(h, "other-tenant");
  await h.t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Other", contactEmail: "other@example.com", workosOrgId: "org_other",
      status: "active", inviteExpiresAt: 0, createdBy: "test",
    });
    await ctx.db.patch("meetings", meetingId, { tenantId });
  });
  await expect(h.t.run((ctx) => requireReportingReady(ctx, h.tenantId))).resolves.toBeNull();
});

it("still rejects a missing tenant", async () => {
  const h = await enrollmentHarness();
  await h.t.run((ctx) => ctx.db.delete("tenants", h.tenantId));
  await expect(h.t.run((ctx) => requireReportingReady(ctx, h.tenantId))).rejects.toThrow("Tenant not found");
});
