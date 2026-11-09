import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { scorecardFixture, whole, history, today, identity } from "../../tests/scorecardFixtures";
import { assembleRowsCsv, exportRowsFromSql, MAX_EXPORT_ROWS, ROW_COLUMNS, rowsExportSql, type RowsKind } from "./rowsExport";

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
  it("credits the closer the payment names, once per payment, and nobody on a disputed payment", async () => {
    const f = await scorecardFixture();
    const rows = await f.t.withIdentity(identity).query(internal.reports.rowsExport.liveRows, { kind: "credits", range: whole, now: whole.toMs });
    expect(rows.filter(r => r.paymentId === f.depositId)).toHaveLength(1);
    // The four non-disputed payments all name the closer whose member this is,
    // as Attribution credits them; the disputed one credits no one.
    expect(rows.filter(r => r.teamMemberId === f.memberId && r.role === "closer")).toHaveLength(4);
    expect(rows.some(r => r.amount === "999.99")).toBe(false);
    // A closer credit row on the deal (here a later reassignment) never adds a closer.
    expect(rows.some(r => r.creditedName === "Later credit")).toBe(false);
  });
  it("exports distinct DM teams alongside named DM closers, once per payment and only after credit", async () => {
    const f = await scorecardFixture();
    const deposit = f.payments.find(p => p._id === f.depositId)!;
    const { teamId, otherTeamId, lateTeamId } = await f.t.run(async ctx => {
      const team = (slug: string) => ctx.db.insert("attributionTeams", { tenantId: f.tenantId, slug, displayName: "DM team",
        utmSource: slug, normalizedUtmSource: slug, isActive: true, createdAt: 0, updatedAt: 0 });
      const teamId = await team("one"); const otherTeamId = await team("two"); const lateTeamId = await team("late");
      for (const [id, at] of [[teamId, deposit.recordedAt], [teamId, deposit.recordedAt - 1],
        [otherTeamId, deposit.recordedAt], [lateTeamId, deposit.recordedAt + 1]] as const) {
        await ctx.db.insert("dealAttributions", { tenantId: f.tenantId, opportunityId: f.dealA, role: "dm_team", teamId: id,
          source: { kind: "booking_utm" }, attributedAt: at, createdAt: at });
      }
      for (const at of [deposit.recordedAt - 1, deposit.recordedAt + 1]) {
        await ctx.db.insert("dealAttributions", { tenantId: f.tenantId, opportunityId: f.dealA, role: "dm_closer", teamMemberId: f.memberId,
          source: { kind: "booking_utm" }, attributedAt: at, createdAt: at });
      }
      return { teamId, otherTeamId, lateTeamId };
    });
    const reader = f.t.withIdentity(identity);
    const live = await reader.query(internal.reports.rowsExport.liveRows, { kind: "credits", range: whole, now: whole.toMs });
    const dm = live.filter(r => r.role === "dm_team" || r.role === "dm_closer");
    const expectedSqlRows = f.payments.filter(p => p.opportunityId === f.dealA && p.status !== "disputed").flatMap(p => {
      const identities = [
        { team_member_id: "", team_id: teamId, role: "dm_team", credited_name: "DM team" },
        { team_member_id: "", team_id: otherTeamId, role: "dm_team", credited_name: "DM team" },
        ...(p.recordedAt > deposit.recordedAt ? [{ team_member_id: "", team_id: lateTeamId, role: "dm_team", credited_name: "DM team" }] : []),
        { team_member_id: f.memberId, team_id: "", role: "dm_closer", credited_name: "Credited closer" },
      ];
      return identities.map(credit => ({ payment_id: p._id, recorded_at_ms: p.recordedAt, deal_id: p.opportunityId,
        person_name: "=Formula person", program: p.programName, type: p.paymentType, status: p.status,
        currency: p.currency, amount_minor: p.amountMinor, ...credit }));
    });
    const sqlRows = exportRowsFromSql("credits", expectedSqlRows, whole.timeZone);
    expect(dm).toHaveLength(7);
    expect(dm).toEqual(expect.arrayContaining(sqlRows));
    expect(dm.filter(r => r.paymentId === f.depositId && r.role === "dm_team").map(r => r.teamId).sort()).toEqual([teamId, otherTeamId].sort());
    const lanes = await reader.query(api.reports.attribution.getLanes, { startDate: whole.fromMs, endDate: whole.toMs });
    for (const role of ["dm_team", "dm_closer"] as const) {
      for (const person of lanes.lanes.find(lane => lane.role === role)!.people) {
        const exported = dm.filter(r => r.role === role && (role === "dm_team" ? r.teamId === person.teamId : r.teamMemberId === person.teamMemberId));
        expect(exported.reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0)).toBe(person.byCurrency[0].amountMinor);
      }
    }
    expect(ROW_COLUMNS.credits.at(-1)).toMatchObject({ key: "teamId", label: "Credited team id" });
    const query = rowsExportSql("credits", whole, whole.toMs);
    expect(query.sql).toContain("FROM analytics.teams WHERE tenant_id = {tenant_id:String}");
    expect(query.sql).toContain("GROUP BY opportunity_id, credited_member_id, credited_team_id, role");
    expect(query.sql).toContain("c.attributed_at_ms <= p.recorded_at_ms");
    expect(query.sql).toContain("c.credited_team_id AS team_id");
    warehouse(expectedSqlRows.filter(row => row.recorded_at_ms < today.fromMs));
    const csv = decode(await reader.action(api.reports.rowsExport.exportRows, { kind: "credits", range: dates }));
    expect(csv).toContain(teamId); expect(csv).toContain("DM team");
  });
  it("pages through events with the Log's member and record filters", async () => {
    const f = await scorecardFixture();
    await f.t.run(async (ctx) => {
      const event = (entityId: string, fields: Record<string, unknown>) => ctx.db.insert("domainEvents", {
        tenantId: f.tenantId, entityType: "meeting", entityId, eventType: "meeting.held", occurredAt: whole.fromMs + 1, source: "closer", ...fields,
      });
      await event("own", { actorUserId: f.closerId });
      await event("tagged", { teamMemberId: f.memberId, source: "system" });
      await event("other", { actorUserId: f.adminId });
      await event("ownLead", { actorUserId: f.closerId, entityType: "lead" });
    });
    const page = await f.t.withIdentity(identity).query(internal.reports.rowsExport.liveEventPage, {
      range: whole, cursor: null, filters: { teamMemberId: f.memberId, actorUserId: f.closerId, entityType: "meeting" },
    });
    expect(page.rows.map(r => r.entityId).sort()).toEqual(["own", "tagged"]);
    expect(page.rows.find(r => r.entityId === "own")).toMatchObject({ actorName: "Assigned closer", label: expect.any(String) });
    expect(Object.keys(page.rows[0])).not.toContain("metadata");
  });
  it("applies the page's filters", async () => {
    const f = await scorecardFixture();
    const calls = await f.t.withIdentity(identity).query(internal.reports.rowsExport.liveRows, {
      kind: "calls", range: whole, now: whole.toMs, filters: { closerId: f.closerId, callType: "follow_up" },
    });
    expect(calls).toEqual([]);
    const sql = rowsExportSql("calls", whole, 1, { programId: f.programId, closerId: f.closerId, callType: "new" });
    expect(sql.sql).toContain("booking_program_id = {program_id:String}");
    expect(sql.sql).toContain("= {closer_id:String}");
    expect(sql.params).toMatchObject({ program_id: f.programId, closer_id: f.closerId, call_type: "new" });
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
    for (const kind of ["payments", "calls", "credits", "events"] as RowsKind[]) {
      const query = rowsExportSql(kind, whole, 123456789);
      const views = query.sql.match(/\banalytics\.\w+/g) ?? [];
      const filters = query.sql.match(/\btenant_id\s*=\s*\{tenant_id:String\}/g) ?? [];
      expect(filters.length).toBeGreaterThanOrEqual(views.length);
      expect(query.sql).not.toContain("123456789"); expect(query.params).not.toHaveProperty("tenant_id");
      expect(query.sql).toContain("LIMIT 200001");
    }
  });
});
