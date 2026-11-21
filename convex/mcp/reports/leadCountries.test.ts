import { afterEach, describe, expect, it, vi } from "vitest";
import workpool from "@convex-dev/workpool/test";
import { adminCaller, adminFixture } from "../../../tests/mcpAdminFixtures";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { initialLifecycleFields } from "../../lib/leadLifecycle";
import type { LeadCountriesAnswer } from "../../analytics/definitions/leadCountries";
import { gatewayAnswerBytes, MAX_ASSISTANT_ANSWER_BYTES } from "../../../lib/assistantReportMerge";

const NOW = Date.parse("2026-11-09T18:00:00Z");
const RANGE = { kind: "custom" as const, startDate: "2026-11-01", endDateInclusive: "2026-11-09" };

async function fixture(rows: { countries: unknown[]; leads: unknown[] }) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const f = await adminFixture();
  workpool.register(f.t, "analyticsWorkpool");
  const watermark = NOW - 3600000;
  await f.t.run((ctx) => ctx.db.insert("analyticsSync", { beatAt: NOW, watermark }));
  vi.stubEnv("CLICKHOUSE_URL", "https://clickhouse.example:8443");
  vi.stubEnv("CLICKHOUSE_USER", "magnus_app");
  vi.stubEnv("CLICKHOUSE_PASSWORD", "test");
  const requests: Array<{ url: URL; sql: string }> = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: { body?: string }) => {
    const sql = String(init?.body);
    requests.push({ url: new URL(String(url)), sql });
    const data = sql.includes("analytics.watermark") ? [{ watermark, beats: 3 }]
      : sql.includes("WHERE lowerUTF8(country) = ") ? rows.leads
      : sql.includes("GROUP BY country_key") ? rows.countries : [];
    return new Response(JSON.stringify({ data, rows: data.length }), { status: 200 });
  });
  return { ...f, caller: adminCaller(f.orgId), watermark, requests };
}

/** Runs the tool's one warehouse job the way the shared pool would. */
async function runTool(f: Awaited<ReturnType<typeof fixture>>, args: { country?: string; limit?: number }) {
  const prepared = JSON.parse(await f.t.query(internal.mcp.reports.leadCountries.prepare, { caller: f.caller, range: RANGE, ...args }));
  await f.t.mutation(internal.mcp.reports.admission.admit, { caller: f.caller, jobs: [prepared.job] });
  const row = (await f.t.run((ctx) => ctx.db.query("mcpReportRequests").take(10))).find((r) => r.status === "running")!;
  await f.t.action(internal.mcp.reports.runner.run, { requestId: row._id, runToken: row.runToken! });
  return await f.t.action(internal.mcp.reports.leadCountries.run, { caller: f.caller, range: RANGE, ...args });
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("magnus_lead_countries", () => {
  it("returns countries from the warehouse, bounded, with country and name text marked as data", async () => {
    const f = await fixture({
      countries: [
        { country_key: "honduras", country_label: "Honduras", leads: 2 },
        { country_key: "el salvador", country_label: "El Salvador", leads: 1 },
        { country_key: "", country_label: "", leads: 1 },
      ],
      leads: [],
    });
    const result = await runTool(f, { limit: 1 });
    expect(result).toMatchObject({
      status: "ready",
      resolvedRange: { startDate: "2026-11-01", endDateInclusive: "2026-11-09" },
      totals: { leads: 4, withCountry: 3, withoutCountry: 1 },
      countries: [{ country: { text: "Honduras", by: "integration" }, leads: 2 }],
      omitted: { countries: 1, leads: 1 },
      isPartial: true,
      reasons: ["warehouse_as_of_watermark"],
    });
    expect(result).not.toHaveProperty("leads");
    const query = f.requests.find((r) => r.sql.includes("GROUP BY country_key"))!;
    expect(query.url.searchParams.get("param_tenant_id")).toBe(f.tenantId);
    expect(f.requests.some((r) => r.sql.includes("WHERE lowerUTF8(country) = "))).toBe(false);
  });

  it("lists one country's leads, matching it ignoring case and spacing", async () => {
    const leadId = "k17287rvf635rqkagmans5sft18cc2cr";
    const f = await fixture({
      // Outside the returned country groups, as past the 500-group cap.
      countries: [],
      leads: [
        { lead_id: leadId, full_name: "Ana Reyes", country: "Honduras", last_qualified_at_ms: NOW - 86400000, matches: 3 },
        { lead_id: "k1764vzzg90bdahgkds6p0er218hhmqr", full_name: null, country: "honduras", last_qualified_at_ms: NOW - 2 * 86400000, matches: 3 },
      ],
    });
    const result = await runTool(f, { country: "  HONDURAS ", limit: 1 }) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: "ready",
      leads: [{ personId: leadId, name: { text: "Ana Reyes", by: "person" }, country: { text: "Honduras", by: "integration" } }],
      // Counted in SQL before its list limit, not from the country list.
      leadsOmitted: 2,
    });
    const query = f.requests.find((r) => r.sql.includes("WHERE lowerUTF8(country) = "))!;
    expect(query.url.searchParams.get("param_country_key")).toBe("honduras");
  });

  it("shrinks the lists to fit the answer limit when names are long", async () => {
    const leads = Array.from({ length: 25 }, (_, i) => ({ lead_id: `k17287rvf635rqkagmans5sft18cc${String(i).padStart(3, "0")}`, full_name: "N".repeat(500), country: "Honduras", last_qualified_at_ms: NOW - i, matches: 25 }));
    const f = await fixture({ countries: [{ country_key: "honduras", country_label: "Honduras", leads: 25 }], leads });
    const result = await runTool(f, { country: "Honduras", limit: 25 }) as { status: string; leads: unknown[]; leadsOmitted: number };
    expect(result.status).toBe("ready");
    expect(gatewayAnswerBytes(result)).toBeLessThanOrEqual(MAX_ASSISTANT_ANSWER_BYTES);
    expect(result.leads.length).toBeLessThan(25);
    expect(result.leads.length + result.leadsOmitted).toBe(25);
  });

  it("refuses a closer, and a blank or overlong country before any warehouse call", async () => {
    const f = await fixture({ countries: [], leads: [] });
    await expect(f.t.query(internal.mcp.reports.leadCountries.prepare, { caller: adminCaller(f.orgId, "claude-ai", "user_alex"), range: RANGE })).rejects.toThrow();
    for (const country of ["   ", "x".repeat(101)]) {
      await expect(f.t.query(internal.mcp.reports.leadCountries.prepare, { caller: f.caller, range: RANGE, country }))
        .rejects.toMatchObject({ data: { code: "report.invalid_request" } });
    }
    expect(f.requests).toHaveLength(0);
  });
});

describe("live lead countries reader", () => {
  it("counts each surviving qualified lead once, under its profile country, else its newest snapshot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const f = await adminFixture();
    const from = Date.parse("2026-11-01T06:00:00Z");
    const to = Date.parse("2026-11-10T06:00:00Z");
    const ids = await f.t.run(async (ctx) => {
      const installationId = await ctx.db.insert("slackInstallations", {
        tenantId: f.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1", botUserId: "B1",
        botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1", notifyChannelName: "qualified",
        installedByWorkosUserId: "user_slack", installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
      });
      const lead = (fields: Record<string, unknown>) => ctx.db.insert("leads", {
        tenantId: f.tenantId, status: "active", firstSeenAt: 0, updatedAt: 0,
        ...initialLifecycleFields({ stage: "qualified", at: 0 }), ...fields,
      });
      const a = await lead({ fullName: "Ana", country: " honduras " });
      const b = await lead({ fullName: "Beto", country: "Honduras" });
      const c = await lead({ fullName: "Caro" });
      const d = await lead({ fullName: "Dani" });
      const g = await lead({ fullName: "Gabi" });
      const e = await lead({ fullName: "Beto old", status: "merged", mergedIntoLeadId: b });
      const event = (leadId: Id<"leads"> | undefined, submittedAt: number, countrySnapshot?: string) => ctx.db.insert("slackQualificationEvents", {
        tenantId: f.tenantId, installationId, ...(leadId ? { leadId } : {}), resultKind: "created_opportunity",
        qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt }, slackUserId: "U1", slackTeamId: "T1",
        fullNameSnapshot: "x", platform: "instagram", handleSnapshot: "x",
        ...(countrySnapshot ? { countrySnapshot } : {}), submittedAt, createdAt: submittedAt,
      });
      await event(a, from + 1000, "Mexico");
      await event(b, from + 2000, "Honduras");
      await event(b, from + 9000, "Honduras");
      await event(c, from + 3000, "Guatemala");
      await event(c, from + 4000, "El\u00a0 Salvador ");
      await event(d, from + 5000);
      // The newest event decides the fallback, even without a country.
      await event(g, from + 1500, "Mexico");
      await event(g, from + 8000);
      await event(e, from + 6000, "Peru");
      await event(undefined, from + 7000, "Chile");
      await event(a, from - 1000, "Belize");
      return { a, b };
    });
    const read = async (country: string | null) => JSON.parse(await f.t.query(internal.reports.leadCountries.liveLeadCountries, { tenantId: f.tenantId, fromMs: from, toMs: to, country })) as LeadCountriesAnswer;
    expect(await read(null)).toEqual({
      totals: { leads: 5, withCountry: 3, withoutCountry: 2 },
      countries: [{ country: "Honduras", leads: 2 }, { country: "El Salvador", leads: 1 }],
      leads: [],
      leadsTotal: 0,
      partial: false,
    });
    expect((await read("honduras")).leads).toEqual([
      { leadId: ids.b, name: "Beto", country: "Honduras", lastQualifiedAt: from + 9000 },
      { leadId: ids.a, name: "Ana", country: "honduras", lastQualifiedAt: from + 1000 },
    ]);
  });
});
