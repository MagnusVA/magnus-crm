import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { scorecardFixture, whole, history, today, identity } from "../../tests/scorecardFixtures";
import { assembleRowsCsv, exportRowsFromSql, MAX_EXPORT_ROWS, rowsExportSql, type RowsKind } from "./rowsExport";

const dates = { startDate: whole.startDate, endDateInclusive: whole.endDateInclusive };
const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(whole.toMs - 1000); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function warehouse(rows: Record<string, unknown>[], watermark = today.fromMs + 1000) {
  vi.stubEnv("CLICKHOUSE_URL", "https://clickhouse.example:8443");
  vi.stubEnv("CLICKHOUSE_USER", "magnus_app"); vi.stubEnv("CLICKHOUSE_PASSWORD", "test-secret");
  const calls: { sql: string; url: URL }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
    const sql = String(init.body); calls.push({ sql, url: new URL(url) });
    return new Response(JSON.stringify({ data: sql.includes("analytics.watermark") ? [{ watermark, beats: 1 }] : rows }));
  });
  return calls;
}
describe("Rows CSV", () => {
  it("writes a BOM, ISO dates, decimal hundredths, quoted cells and formula guards", () => {
    const rows = exportRowsFromSql("payments", [{ payment_id: "p", recorded_at_ms: history.fromMs, person_name: "=danger",
      program: 'A, "B"', currency: "JPY", amount_minor: 12345, status: "disputed" }], whole.timeZone);
    const bytes = assembleRowsCsv("payments", rows, []);
    expect([...new Uint8Array(bytes).slice(0, 3)]).toEqual([239, 187, 191]);
    const csv = decode(bytes);
    expect(csv).toContain(new Date(history.fromMs).toISOString());
    expect(csv).toContain("America/Tegucigalpa"); expect(csv).toContain("123.45");
    expect(csv).toContain("'=danger"); expect(csv).toContain('"A, ""B"""'); expect(csv).toContain("disputed");
  });
  it("appends today's live payments after historical rows from mocked ClickHouse", async () => {
    const f = await scorecardFixture();
    const calls = warehouse([{ payment_id: "warehouse-payment", recorded_at_ms: history.fromMs + 1000,
      deal_id: "historic-deal", person_name: "History", program: "Old", type: "deposit", status: "verified", currency: "USD", amount_minor: 3000, closer_name: "Closer" }]);
    const bytes = await f.t.withIdentity(identity).action(api.reports.rowsExport.exportRows, { kind: "payments", range: dates });
    const csv = decode(bytes);
    expect(csv).toContain("warehouse-payment"); expect(csv).toContain("900.00"); expect(csv).toContain("250.00");
    expect(csv).not.toContain(f.depositId);
    expect(csv.indexOf("warehouse-payment")).toBeLessThan(csv.indexOf("900.00"));
    expect(calls).toHaveLength(2);
    expect(calls[1].url.searchParams.get("param_tenant_id")).toBe(f.tenantId);
    expect(calls[1].url.searchParams.get("param_to_ms")).toBe(String(today.fromMs));
    expect(calls[1].sql).toContain("max_execution_time = 30");
  });
  it("keeps yesterday live before a sync crosses today's business boundary", async () => {
    const f = await scorecardFixture(); const calls = warehouse([], history.fromMs + 1000);
    const bytes = await f.t.withIdentity(identity).action(api.reports.rowsExport.exportRows, { kind: "payments", range: dates });
    expect(decode(bytes)).toContain(f.depositId); expect(calls).toHaveLength(1);
  });
  it("doesn't wake ClickHouse for today's rows", async () => {
    const f = await scorecardFixture(); const calls = warehouse([]);
    await f.t.withIdentity(identity).action(api.reports.rowsExport.exportRows,
      { kind: "payments", range: { startDate: today.startDate, endDateInclusive: today.endDateInclusive } });
    expect(calls).toHaveLength(0);
  });
  it("rejects the 200,001st warehouse row with a safe error", async () => {
    const f = await scorecardFixture(); warehouse(Array.from({ length: MAX_EXPORT_ROWS + 1 }, () => ({})));
    await expect(f.t.withIdentity(identity).action(api.reports.rowsExport.exportRows, { kind: "payments", range: dates })).rejects.toThrow("Choose a shorter range");
    expect(() => assembleRowsCsv("credits", Array(MAX_EXPORT_ROWS).fill({}), [{}])).toThrow("Choose a shorter range");
  });
  it("enforces admin access before fetching any warehouse data", async () => {
    const f = await scorecardFixture(); const calls = warehouse([]);
    await expect(f.t.action(api.reports.rowsExport.exportRows, { kind: "calls", range: dates })).rejects.toThrow("Not authenticated");
    await expect(f.t.withIdentity({ subject: "score_closer", org_id: identity.org_id }).action(api.reports.rowsExport.exportRows,
      { kind: "credits", range: dates })).rejects.toThrow("Insufficient permissions");
    expect(calls).toHaveLength(0);
  });
  it("exports each payment/person/role once and never credits a later fact", async () => {
    const f = await scorecardFixture();
    const rows = await f.t.withIdentity(identity).query(internal.reports.rowsExport.liveRows, { kind: "credits", range: whole, now: whole.toMs });
    expect(rows.filter(r => r.paymentId === f.depositId)).toHaveLength(1);
    expect(rows.filter(r => r.teamMemberId === f.memberId)).toHaveLength(3); // deposit, installment and disputed raw payment
    expect(rows.some(r => r.creditedName === "Later credit")).toBe(false);
  });
  it("exports latest meeting credit, fallback owner, moved slots and attendance", async () => {
    const f = await scorecardFixture();
    const rows = await f.t.withIdentity(identity).query(internal.reports.rowsExport.liveRows, { kind: "calls", range: whole, now: whole.toMs });
    expect(rows.find(r => r.meetingId === f.meetingA)).toMatchObject({ closerName: "Credited closer", attendance: "held", callType: "new" });
    expect(rows.find(r => r.meetingId === f.replacement)).toMatchObject({ closerName: "Later credit", attendance: "canceled", replacedMeetingId: f.meetingA });
    expect(rows.some(r => r.closerName === "Assigned closer")).toBe(true);
    expect(rows.some(r => r.attendance === "moved")).toBe(true);
    expect(rows.some(r => r.attendance === "not recorded")).toBe(true);
  });
  it("parameterizes every tenant view in all three export templates", () => {
    for (const kind of ["payments", "calls", "credits"] as RowsKind[]) {
      const query = rowsExportSql(kind, whole, 123456789);
      const views = query.sql.match(/\banalytics\.\w+/g) ?? [];
      const filters = query.sql.match(/\btenant_id\s*=\s*\{tenant_id:String\}/g) ?? [];
      expect(filters.length).toBeGreaterThanOrEqual(views.length);
      expect(query.sql).not.toContain("123456789"); expect(query.params).not.toHaveProperty("tenant_id");
      expect(query.sql).toContain("LIMIT 200001");
    }
  });
});
