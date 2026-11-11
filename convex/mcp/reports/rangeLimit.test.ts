import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../../_generated/api";
import { adminFixture } from "../../../tests/mcpAdminFixtures";
import { callTool, testCaller } from "../../../tests/mcpHarness";
import { resolveAnalyticsRange } from "../../../lib/analyticsRange";
import { setting } from "../../../tests/scorecardFixtures";
import * as live from "./live";

async function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-11-09T18:00:00Z"));
  const f = await adminFixture();
  await f.t.run(ctx => ctx.db.patch("tenants", f.tenantId, { businessDay: setting, businessDayAppliedVersion: 0 }));
  return { ...f, caller: testCaller(f.orgId, "claude-ai", "user_jordan"),
    range: resolveAnalyticsRange({ kind: "custom", startDate: "2026-11-09", endDateInclusive: "2026-11-09" }, setting, Date.now()) };
}
async function seedPayments(f: Awaited<ReturnType<typeof fixture>>) {
  await f.t.run(async ctx => {
    const programId = await ctx.db.insert("tenantPrograms", { tenantId: f.tenantId, name: "Program", normalizedName: "program",
      createdByUserId: f.adminId, createdAt: Date.now(), updatedAt: Date.now() });
    for (let i = 0; i < 2501; i++) await ctx.db.insert("paymentRecords", { tenantId: f.tenantId,
      amountMinor: 10000, currency: "USD", recordedByUserId: f.adminId, programId, programName: "Program",
      paymentType: "deposit", status: "verified", recordedAt: Date.now(), origin: "closer_meeting" });
  });
}
const request = { report: "scorecard", panel: "cash", range: { kind: "preset", preset: "today" } };
afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("assistant live report range limits", () => {
  it("answers range_too_large when an admin's live cash panel exceeds the cap", async () => {
    const f = await fixture();
    await seedPayments(f);
    // adminFixture signs the admin's token and connects its MCP session through mcpConnect.
    const result = await callTool(f.t, f.adminToken, f.adminSession, "magnus_report", request);
    const answer = result.data as Record<string, unknown>;
    expect(result.isError, result.text).toBe(false);
    expect(answer.status).toBe("unavailable");
    expect(answer.reasons).toEqual(["range_too_large"]);
    expect(answer.isPartial).toBe(true);
  }, 30_000);
  it("preserves the coded rejection from the internal live panel query", async () => {
    const f = await fixture();
    await seedPayments(f);
    let error: unknown;
    try { await f.t.query(internal.mcp.reports.read.panel, { caller: f.caller, id: "scorecard.cash", filters: {}, range: f.range }); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ConvexError);
    if (!(error instanceof ConvexError)) throw new Error("Expected a coded range rejection");
    expect(error.data).toEqual({ code: "reports.range_too_large", message: "Choose a shorter range" });
  }, 30_000);
  it("keeps other live reader failures classified as live_reader_unavailable", async () => {
    const f = await fixture();
    const reader = vi.spyOn(live, "readLivePanel").mockRejectedValue(new Error("Live reader failed"));
    const result = await callTool(f.t, f.adminToken, f.adminSession, "magnus_report", request);
    const answer = result.data as Record<string, unknown>;
    expect(reader).toHaveBeenCalledOnce();
    expect(result.isError, result.text).toBe(false);
    expect(answer.status).toBe("unavailable");
    expect(answer.reasons).toEqual(["live_reader_unavailable"]);
    expect(answer.isPartial).toBe(true);
  }, 30_000);
});
