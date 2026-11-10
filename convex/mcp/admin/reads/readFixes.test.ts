import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../../../_generated/api";
import { adminCaller, adminFixture } from "../../../../tests/mcpAdminFixtures";
import { callTool } from "../../../../tests/mcpHarness";
import { businessDayStart } from "../../../../lib/businessDay";
import { insertProgram } from "../../../../tests/closerPipelineDeskFixtures";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-10T18:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const reads = internal.mcp.admin.reads;

describe("admin read QA regressions", () => {
  it("returns unknown totals for unsaved reports and rejects non-closers, bad IDs, invalid and future dates over MCP", async () => {
    const f = await adminFixture();
    const call = (args: Record<string, unknown>) => callTool(f.t, f.adminToken, f.adminSession, "magnus_end_of_day", args);
    const empty = await call({ date: "2026-11-09", closerId: f.closerId });
    expect(empty.isError).toBe(false);
    expect(empty.data).toMatchObject({ rows: [{ calls: null, won: null, status: "No report saved" }] });
    for (const [args, code] of [
      [{ date: "2026-11-09", closerId: f.adminId }, "mcp.invalid_closer"],
      [{ date: "2026-11-09", closerId: f.tenantId }, "mcp.invalid_argument"],
      [{ date: "2026-11-09", closerId: "garbage" }, "mcp.invalid_argument"],
      [{ date: "2026-02-30" }, "range.invalid"],
      [{ date: "11/05/2026" }, "range.invalid"],
      [{ date: "2026-11-11" }, "range.invalid"],
    ] as const) {
      const result = await call(args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain(code);
    }
  });
  it("validates activity dates, tools, IDs and native receipt cursors", async () => {
    const f = await adminFixture();
    const caller = adminCaller(f.orgId);
    const query = (args: Record<string, string>) => f.t.query(reads.assistantActivity.run, { caller, ...args });
    for (const since of ["2026-02-30", "2026-02-30T12:00:00Z", "1794254400000", "Nov 9 2026", "2026-11-09T24:00:00Z", "2026-11-09T12:00:00"]) {
      await expect(query({ since })).rejects.toThrow("mcp.invalid_since");
    }
    for (const since of ["2026-11-09", "2026-11-09T12:00:00Z", "2026-11-09T12:00:00.12-06:00"]) await expect(query({ since })).resolves.toMatchObject({ items: [] });
    await expect(query({ tool: "magnus_made_up" })).rejects.toThrow("mcp.invalid_tool");
    await expect(query({ userId: f.tenantId })).rejects.toThrow("userId");
    await expect(query({ planId: f.closerId })).rejects.toThrow("planId");
    await expect(query({ cursor: JSON.stringify({ phase: "receipts", cursor: "junk" }) })).rejects.toThrow("mcp.invalid_cursor");
  });
  it("interprets an activity date at the tenant business-day start", async () => {
    const f = await adminFixture();
    const day = { timeZone: "Asia/Tokyo", dayStartHour: 5 };
    const at = businessDayStart("2026-11-09", day);
    await f.t.run(async ctx => {
      await ctx.db.patch("tenants", f.tenantId, { businessDay: day });
      for (const usedAt of [at - 1, at]) await ctx.db.insert("mcpConfirmations", { tenantId: f.tenantId, userId: f.adminId, tool: "magnus_correct_payment", tokenHash: String(usedAt), argsHash: "args", preview: "preview", expiresAt: at, usedAt, kind: "single", status: "applied" });
    });
    const result = await f.t.query(reads.assistantActivity.run, { caller: adminCaller(f.orgId), since: "2026-11-09", tool: "magnus_correct_payment" });
    expect(result.items).toHaveLength(1);
  });
  it("marks unused shared coverage as not_used, and a missing inherited route as a gap", async () => {
    const f = await adminFixture();
    const teamId = await f.t.run(async ctx => {
      await ctx.db.patch("tenants", f.tenantId, { bookingCoverageMigratedAt: 1 });
      await insertProgram(ctx, f.tenantId, f.ownerId, "Program");
      return ctx.db.insert("attributionTeams", { tenantId: f.tenantId, displayName: "Team", slug: "team", utmSource: "team", normalizedUtmSource: "team", usesSharedEventTypes: false, isActive: true, createdAt: 0, updatedAt: 0 });
    });
    const query = () => f.t.query(reads.setup.run, { caller: adminCaller(f.orgId), area: "coverage" });
    expect((await query()).items.filter(i => i.id.startsWith("shared:")).every(i => i.state === "not_used")).toBe(true);
    await f.t.run(ctx => ctx.db.patch("attributionTeams", teamId, { usesSharedEventTypes: true }));
    expect((await query()).items.filter(i => i.id.startsWith("shared:")).every(i => i.state === "gap")).toBe(true);
  });
  it("directs partial setup reads to the editor and uses the most recent Calendly observation", async () => {
    const f = await adminFixture();
    await f.t.run(async ctx => {
      for (let i = 0; i < 26; i++) await insertProgram(ctx, f.tenantId, f.ownerId, `Program ${i}`);
      await ctx.db.insert("tenantCalendlyConnections", { tenantId: f.tenantId, calendlyAccessToken: "secret", lastEventTypeSyncCompletedAt: Date.now() - 100000, lastTokenRefreshAt: Date.now() - 1000, lastHealthCheckAt: Date.now() });
    });
    expect(await f.t.query(reads.setup.run, { caller: adminCaller(f.orgId), area: "programs" })).toMatchObject({ isPartial: true, reason: expect.stringContaining("openInMagnus") });
    const health = await f.t.query(reads.health.run, { caller: adminCaller(f.orgId), area: "calendly" });
    expect(health.rows[0].observedAt).toContain("12:00");
  });
});
