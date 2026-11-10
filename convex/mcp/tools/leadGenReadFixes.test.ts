import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import { createMcpHarness, seedTenantWithLeadGen, testCaller, callTool, mcpConnect } from "../../../tests/mcpHarness";
import { businessDateForInstant, businessDayStart, addBusinessDays } from "../../../lib/businessDay";
import { encodeLeadGenCursor } from "../../leadGen/floor";
import { normalizeLeadGenProspectInput } from "../../leadGen/normalization";
import { normalizeSocialHandle } from "../../lib/normalization";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function fixture() {
  const h = await createMcpHarness();
  const seed = await seedTenantWithLeadGen(h.t);
  const caller = testCaller(seed.orgId, "claude-ai", "user_admin");
  const token = await h.signToken("user_admin", { org_id: seed.orgId });
  const { sessionId } = await mcpConnect(h.t, token);
  const capture = () => h.t.withIdentity({ subject: "user_sofia", org_id: seed.orgId }).mutation(api.leadGen.capture.submit, { source: "instagram", rawHandleOrProfileUrl: "m.instagram.com/real.handle/reels/", originKind: "follower" });
  return { ...h, ...seed, caller, token, sessionId, capture };
}
describe("lead gen read QA regressions", () => {
  it.each(["m.instagram.com/real.handle", "HTTPS://WWW.INSTAGRAM.COM/Real.Handle", "instagram.com/real.handle/reels/", "instagram.com/real.handle/tagged/?x=1"])("normalizes profile %s for lookup and captures", value => {
    expect(normalizeSocialHandle(value, "instagram")).toBe("real.handle");
    expect(normalizeLeadGenProspectInput({ source: "instagram", rawHandleOrProfileUrl: value })).toMatchObject({ normalizedHandle: "real.handle", profileUrl: "https://instagram.com/real.handle", dedupeKey: "instagram:real.handle" });
  });
  it.each(["instagram.com/p/abc", "instagram.com/reel/abc", "m.instagram.com/p/abc", "instagram.com/invalid!/reels/", "instagram.com/g/tagged/", "instagram.com/real.handle/reels/abc"])("rejects invalid or post URL %s", value => {
    expect(() => normalizeLeadGenProspectInput({ source: "instagram", rawHandleOrProfileUrl: value })).toThrow();
  });
  it("keeps every equivalent handle input and wraps native handle cursor errors", async () => {
    const f = await fixture();
    await f.capture();
    const handles = ["@real.handle", "HTTPS://WWW.INSTAGRAM.COM/Real.Handle/reels/", "m.instagram.com/real.handle/tagged/"];
    const result = await f.t.query(internal.mcp.tools.leadGenHandles.check, { caller: f.caller, handles });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].inputs).toEqual(handles);
    expect(result.results.every(row => row.handle === "real.handle" && "captures" in row && row.captures?.length === 1)).toBe(true);
    const bad = await callTool(f.t, f.token, f.sessionId, "magnus_check_handles", { handles: ["real.handle"], cursor: "junk" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("handles.invalid_cursor");
  });
  it("returns small team lists on the first roster page, excludes teams without lead generators, and keeps partial/cursor consistent", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.insert("attributionTeams", { tenantId: f.tenantId, displayName: "Phone Setters", slug: "phone", utmSource: "phone", normalizedUtmSource: "phone", isActive: true, createdAt: 0, updatedAt: 0 }));
    const roster = await f.t.query(internal.mcp.tools.leadGenFloor.roster, { caller: f.caller });
    expect(roster).toMatchObject({ teams: [{ teamId: f.teamId }], cursor: null, isPartial: false });
    await f.t.run(async ctx => {
      const base = (await ctx.db.get("leadGenWorkers", f.sofiaWorkerId))!;
      const { _id, _creationTime, ...fields } = base;
      void _id; void _creationTime;
      for (let i = 0; i < 27; i++) await ctx.db.insert("leadGenWorkers", { ...fields, email: `${i}@example.com` });
    });
    const page = await f.t.query(internal.mcp.tools.leadGenFloor.roster, { caller: f.caller });
    expect(page.cursor).toBeTypeOf("string");
    expect(page.isPartial).toBe(true);
  });
  it("hides inactive specialists without today's captures", async () => {
    const f = await fixture();
    await f.capture();
    await f.t.run(async ctx => {
      await ctx.db.patch("leadGenWorkers", f.sofiaWorkerId, { isActive: false });
      await ctx.db.patch("leadGenWorkers", f.daniWorkerId, { isActive: false });
    });
    const page = await f.t.query(internal.mcp.tools.leadGenFloor.floor, { caller: f.caller });
    expect(page.specialists.map(row => row.workerId)).toEqual([f.sofiaWorkerId]);
  });
  it("returns structured argument and cursor errors through MCP", async () => {
    const f = await fixture();
    await f.capture();
    const day = businessDateForInstant(Date.now());
    const calls = [
      ["magnus_lead_gen_floor", { teamId: f.sofiaWorkerId }],
      ["magnus_lead_gen_submissions", { teamId: f.sofiaWorkerId }],
      ["magnus_lead_gen_submissions", { workerId: f.teamId }],
    ] as const;
    for (const [name, args] of calls) {
      const result = await callTool(f.t, f.token, f.sessionId, name, args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("mcp.invalid_argument");
    }
    for (const [name, args] of [
      ["magnus_lead_gen_floor", { cursor: encodeLeadGenCursor(JSON.stringify(["floor", f.tenantId, day, null]), "junk") }],
      ["magnus_lead_gen_roster", { cursor: encodeLeadGenCursor(JSON.stringify(["roster", f.tenantId, false]), "junk") }],
    ] as const) {
      const result = await callTool(f.t, f.token, f.sessionId, name, args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("lead_gen.invalid_cursor");
    }
    const start = businessDayStart(day), end = businessDayStart(addBusinessDays(day, 1)) - 1;
    const badSubmissions = await callTool(f.t, f.token, f.sessionId, "magnus_lead_gen_submissions", {
      cursor: encodeLeadGenCursor(JSON.stringify(["submissions", f.tenantId, start, end, null, null, null]), "junk"),
    });
    expect(badSubmissions.isError).toBe(true);
    expect(badSubmissions.text).toContain("lead_gen.invalid_cursor");
    expect(badSubmissions.text).not.toContain("isConvexSystemError");
    await expect(f.t.query(internal.mcp.tools.leadGenSubmissions.readPage, { caller: f.caller, startTimestamp: 0, endTimestamp: Date.now(), cursor: "junk", numItems: 2 })).rejects.toThrow("lead_gen.invalid_cursor");
  });
  it("normalizes IDs and wraps native cursors in the remaining scoped lead-gen reads", async () => {
    const f = await fixture();
    const caller = testCaller(f.orgId, "claude-ai", "user_sofia");
    await f.capture();
    await expect(f.t.query(internal.mcp.tools.leadGenRespark.person, { caller, itemIds: [f.teamId] })).rejects.toThrow("mcp.invalid_argument");
    const day = businessDateForInstant(Date.now());
    await expect(f.t.query(internal.mcp.tools.leadGenActivity.readActivity, { caller,
      cursor: JSON.stringify({ key: JSON.stringify([f.tenantId, f.sofiaId, { kind: "custom", startBusinessDate: day, endBusinessDateInclusive: day }]), cursor: "junk" }),
    })).rejects.toThrow("activity.invalid_cursor");
    const batchId = await f.t.run(ctx => ctx.db.insert("resparkBatches", { tenantId: f.tenantId, userId: f.sofiaId, workerId: f.sofiaWorkerId, teamId: f.teamId, createdAt: Date.now(), heldUntil: Date.now() + 60000, size: 0, requestedSize: 1 }));
    await expect(f.t.query(internal.mcp.tools.leadGenRespark.batch, { caller,
      cursor: JSON.stringify({ batchId, userId: f.sofiaId, tenantId: f.tenantId, cursor: "junk" }),
    })).rejects.toThrow("respark.invalid_cursor");
  });

});
