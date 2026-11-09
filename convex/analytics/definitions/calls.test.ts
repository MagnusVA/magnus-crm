import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal, api } from "../../_generated/api";
import {
  callsReportFixture,
  warehouseMonthFixture,
  from,
  identity,
  now,
  range,
  to,
} from "../../../tests/callsReportFixtures";
import { expectSameAnswer } from "../../../tests/analyticsParity";
import { callFactsSql, callsReports } from "./calls";
import { docFromRow } from "../rows";
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
  it("finalizes a full month without live dimension caps or dimension reads", async () => {
    const f = await warehouseMonthFixture();
    const payload = await f.t.query(
      internal.analytics.results.previewFinalize,
      {
        tenantId: f.tenantId,
        reportId: "calls.summary",
        range,
        filtersJson: JSON.stringify({
          programId: null,
          closerId: null,
          callType: null,
        }),
        rowsJson: JSON.stringify({ meetings: f.warehouseRows }),
      },
    );
    expect(JSON.parse(payload)).toMatchObject({
      partial: false,
      counts: { held: 1001 },
      mode: { standard: { held: 501 }, priority: { held: 500 } },
    });
    await f.t.run(async (ctx) => {
      const get = vi.spyOn(ctx.db, "get");
      const { warehouseCallFacts } = await import("./calls");
      const facts = await warehouseCallFacts(ctx, f.tenantId, f.warehouseRows);
      expect(facts.partial).toBe(false);
      expect(facts.facts.at(-1)).toMatchObject({
        leadName: "Warehouse person 1000",
        dealOutcome: "won",
        standard: true,
        closerName: "Ana",
      });
      expect(get.mock.calls.every(([table]) => table === "users")).toBe(true);
      expect(get).toHaveBeenCalledTimes(1);
    });
  });
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

describe("warehouse call rows", () => {
  // Production ClickHouse returned `m.id`, `m.status` and
  // `m.rescheduled_from_meeting_id` when a joined subquery reused those names.
  it("never joins a column that shares a meeting column's name", () => {
    for (const subquery of callFactsSql.split("LEFT ANY JOIN").slice(1)) {
      const select = /SELECT\s+([\s\S]*?)\s+FROM/.exec(subquery)![1];
      for (const column of select.split(",").map((part) => part.trim())) {
        expect(column, column).not.toMatch(/^(id|status|rescheduled_from_meeting_id)$/);
      }
    }
  });
  it("refuses a row whose column a join renamed", () => {
    expect(() => docFromRow({ "m.id": "k1", status: "held" })).toThrow("m.id");
    expect(docFromRow({ id: "k1", creation_time_ms: 5, scheduled_at_ms: 9 })).toEqual({ _id: "k1", _creationTime: 5, scheduledAt: 9 });
  });
});
