import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import {
  callsReportFixture,
  from,
  identity,
  now,
  range,
  to,
} from "../../../tests/callsReportFixtures";
import { expectSameAnswer } from "../../../tests/analyticsParity";
import { callsReports } from "./calls";
import { peopleCloserReports } from "./people";
import type { Id } from "../../_generated/dataModel";

// Test the exported definitions before the lead wires the production registry.
vi.mock("../registry", async () => {
  const { callsReports } = await import("./calls");
  const { peopleCloserReports } = await import("./people");
  return {
    getReportDefinition: (id: string) =>
      [...callsReports, ...peopleCloserReports].find((r) => r.id === id)!,
  };
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());
describe("Calls warehouse parity", () => {
  it("uses SQL evidence and the same builder, including historical closer filtering", async () => {
    const f = await callsReportFixture();
    for (const closerId of [null, f.ana, f.beto]) {
      await expectSameAnswer({
        t: f.t,
        identity,
        tenantId: f.tenantId,
        reportId: "calls.summary",
        live: api.reports.calls.getCallsSummary,
        liveArgs: {
          startDate: from,
          endDate: to,
          ...(closerId ? { closerId } : {}),
        },
        filters: { programId: null, closerId, callType: null },
        range,
        rows: f.rows,
      });
    }
  });
});
describe("new report SQL rules", () => {
  for (const definition of [...callsReports, ...peopleCloserReports]) {
    it(`${definition.id} filters every view and binds all values`, () => {
      const filters = new Proxy({} as Record<string, string>, {
        get: (_target, key) =>
          typeof key === "string" && key !== "then"
            ? "FILTER_SENTINEL"
            : undefined,
      });
      const queries = definition.sql({
        tenantId: "TENANT_SENTINEL" as Id<"tenants">,
        filters,
        range: { ...range, fromMs: 1788242400123, toMs: 1790834400456 },
      });
      for (const [name, query] of Object.entries(queries)) {
        const views = query.sql.match(/\banalytics\.(?!watermark\b)\w+/g) ?? [];
        const tenantFilters =
          query.sql.match(/\btenant_id\s*=\s*\{tenant_id:String\}/g) ?? [];
        expect(views.length, name).toBeGreaterThan(0);
        expect(tenantFilters.length, name).toBeGreaterThanOrEqual(views.length);
        expect(query.sql).not.toMatch(
          /convex_app\.|FILTER_SENTINEL|TENANT_SENTINEL|1788242400123|1790834400456/,
        );
        expect(query.params ?? {}).not.toHaveProperty("tenant_id");
        expect(query.params).toMatchObject({
          from_ms: 1788242400123,
          to_ms: 1790834400456,
          tz: range.timeZone,
          day_start_hour: 1,
        });
      }
    });
  }
});
