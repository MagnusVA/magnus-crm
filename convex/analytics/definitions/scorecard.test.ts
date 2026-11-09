import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import { scorecardReports } from "./scorecard";
import { buildLifecycle } from "../../reports/scorecard";
import { expectSameAnswer, rowFromDoc } from "../../../tests/analyticsParity";
import { scorecardFixture, whole, identity } from "../../../tests/scorecardFixtures";
import type { Id } from "../../_generated/dataModel";

// The lead owns registry.ts. Register this task's reports only inside parity tests.
vi.mock("../registry", async () => {
  const { scorecardReports: reports } = await import("./scorecard");
  const get = (id: string) => {
    const report = reports.find(r => r.id === id); if (!report) throw new Error(`Unknown report ${id}`); return report;
  };
  return { getReportDefinition: get, findReportDefinition: get, listReportDefinitions: () => reports };
});
afterEach(() => vi.useRealTimers());
describe("Scorecard source parity", () => {
  it("matches each live reader from the SQL rows with the same builder", async () => {
    vi.useFakeTimers(); vi.setSystemTime(whole.toMs + 1000);
    const f = await scorecardFixture();
    const counts = buildLifecycle(f.people, whole);
    const lifecycle = { ...counts.stages, entered: counts.cohort.entered,
      cohort_qualified: counts.cohort.qualified, cohort_booked: counts.cohort.booked, cohort_showed: counts.cohort.showed, cohort_customer: counts.cohort.customer };
    const rows = {
      payments: f.payments.map(d => rowFromDoc("paymentRecords", d)), deals: f.deals.map(d => rowFromDoc("opportunities", d)),
      meetings: f.meetings.map(d => rowFromDoc("meetings", d)), reminders: f.reminders.filter(r => r.type === "manual_reminder").map(d => rowFromDoc("followUps", d)),
      lifecycle: [lifecycle], responses: f.responses.map(d => rowFromDoc("meetingFormResponses", d)),
      held: [{ opportunity_id: f.dealA }, { opportunity_id: f.dealB }],
    };
    const base = { t: f.t, tenantId: f.tenantId, identity, range: whole, rows, filters: { programId: null }, liveArgs: { range: whole } };
    await expectSameAnswer({ ...base, reportId: "scorecard.funnel", live: api.reports.scorecard.funnel });
    await expectSameAnswer({ ...base, reportId: "scorecard.cash", live: api.reports.scorecard.cash });
    await expectSameAnswer({ ...base, reportId: "scorecard.follow_through", live: api.reports.scorecard.followThrough });
    await expectSameAnswer({ ...base, reportId: "scorecard.origins", live: api.reports.scorecard.origins });
    await expectSameAnswer({ ...base, reportId: "scorecard.answers", live: api.reports.scorecard.answers,
      liveArgs: { range: whole, fieldKey: "budget" }, filters: { programId: null, fieldKey: "budget" } });
  });
  it("validates required answer fields and program ids", async () => {
    const f = await scorecardFixture();
    await f.t.run(async ctx => {
      const definition = scorecardReports.find(d => d.id === "scorecard.answers")!;
      const viewer = { tenantId: f.tenantId, userId: f.adminId, role: "tenant_admin" as const, workosUserId: identity.subject };
      await expect(definition.parseFilters(ctx, {}, viewer)).rejects.toThrow("Choose a form field");
      await expect(definition.parseFilters(ctx, { fieldKey: "budget", programId: f.adminId }, viewer)).rejects.toThrow("Invalid filter");
      expect(await definition.parseFilters(ctx, { fieldKey: " budget ", programId: f.programId }, viewer)).toEqual({ programId: f.programId, fieldKey: "budget" });
    });
  });
});
describe("Scorecard SQL contract", () => {
  for (const definition of scorecardReports) it(`${definition.id} filters every view and parameterizes all caller values`, () => {
    const queries = definition.sql({ tenantId: "TENANT_SENTINEL" as Id<"tenants">,
      filters: { programId: "FILTER_SENTINEL", fieldKey: "FILTER_SENTINEL" }, range: { ...whole, fromMs: 1788242400123, toMs: 1790834400456 } });
    expect(definition.page).toBe("scorecard"); expect(definition.day).toBe("business");
    expect(definition.roles).toEqual(["tenant_master", "tenant_admin"]);
    for (const query of Object.values(queries)) {
      const views = query.sql.match(/\banalytics\.(?!watermark\b)\w+/g) ?? [];
      const tenants = query.sql.match(/\btenant_id\s*=\s*\{tenant_id:String\}/g) ?? [];
      expect(views.length).toBeGreaterThan(0); expect(tenants.length).toBeGreaterThanOrEqual(views.length);
      expect(query.sql).not.toMatch(/convex_app\.|FILTER_SENTINEL|TENANT_SENTINEL|1788242400123|1790834400456/);
      expect(query.params).not.toHaveProperty("tenant_id");
      expect(query.params).toMatchObject({ from_ms: 1788242400123, to_ms: 1790834400456, tz: whole.timeZone, day_start_hour: 1 });
    }
  });
});
