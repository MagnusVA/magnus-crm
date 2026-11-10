import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FunctionReturnType } from "convex/server";
import { api, internal } from "../../_generated/api";
import { readProspectConversions } from "../../leadGen/conversions";
import { syncProspectConversions } from "../../lib/prospectConversions";
import { prospectConversions } from "../../reporting/aggregates";
import { seedTenantWithLeadGen } from "../../../tests/mcpHarness";
import { noShow, package2Fixture, SHIFT_NOW, SHIFT_DAY, toolData } from "../../../tests/leadGenPackage2Fixtures";

type Outcomes = FunctionReturnType<typeof internal.mcp.tools.leadGenOutcomes.outcomes>;
const TOOL = "magnus_my_lead_gen_outcomes";
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(SHIFT_NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("lead gen outcomes through /mcp", () => {
  it("matches cumulative conversions, keeps first capture credit and handles pre-capture stages", async () => {
    const f = await package2Fixture();
    const a = await f.capture("first.person");
    const b = await f.capture("earlier.qualified");
    await f.capture("first.person", "user_dani");
    await f.t.run(async ctx => {
      for (const [captured, qualified] of [[a, SHIFT_NOW], [b, SHIFT_NOW - 7_200_000]] as const) {
        await ctx.db.patch("leads", captured.leadId!, { lifecycleStage: "qualified", lifecycleStageEnteredAt: {
          prospect: SHIFT_NOW - 7_200_000, in_conversation: SHIFT_NOW - 3_600_000, qualified } });
        const prospect = (await ctx.db.get("leadGenProspects", captured.prospectId))!;
        await syncProspectConversions(ctx, prospect, await ctx.db.get("leads", captured.leadId!));
      }
    });
    const result = toolData<Outcomes>(await f.tool(TOOL));
    const conversions = await f.t.run(ctx => readProspectConversions(ctx, f.tenantId, { startDayKey: SHIFT_DAY, endDayKey: SHIFT_DAY }));
    expect(result.counts).toEqual(conversions.rows.find(row => row.workerId === f.sofiaWorkerId)!.counts);
    expect(result.counts).toMatchObject({ prospect: 2, in_conversation: 2, qualified: 1, customer: 0 });
    const filtered = toolData<Outcomes>(await f.tool(TOOL, { stage: "qualified" }));
    expect(filtered.people.map(person => person.handle)).toEqual(["first.person"]);
    const dani = await f.agent("user_dani");
    expect(toolData<Outcomes>(await dani(TOOL)).people).toEqual([]);
  });

  it("shows old notes, excludes pre-capture calls, and keeps earlier no-shows behind newer bookings", async () => {
    const f = await package2Fixture(); const captured = await f.capture("history.person");
    await f.t.run(async ctx => {
      const first = await noShow(ctx, f, captured.leadId!, { scheduledAt: SHIFT_NOW - 3_600_001, note: "Too early" });
      await noShow(ctx, f, captured.leadId!, { opportunityId: first.opportunityId, scheduledAt: SHIFT_NOW - 3_600_000,
        category: "late_cancel", note: "A note written before this release" });
      await noShow(ctx, f, captured.leadId!, { opportunityId: first.opportunityId, scheduledAt: SHIFT_NOW - 1000 });
      await noShow(ctx, f, captured.leadId!, { opportunityId: first.opportunityId, scheduledAt: SHIFT_NOW + 1000, status: "scheduled" });
      await noShow(ctx, f, captured.leadId!, { scheduledAt: SHIFT_NOW + 2000, status: "held" });
    });
    const row = toolData<Outcomes>(await f.tool(TOOL)).people[0];
    expect(row.noShows).toHaveLength(2); expect(row.historyPartial).toBe(false);
    expect(row.noShows[0]).toMatchObject({ category: null, note: null, withheld: null });
    expect(row.noShows[1]).toMatchObject({ category: "late_cancel", note: { text: "A note written before this release", personSupplied: true } });
    expect(JSON.stringify(row)).not.toContain("Too early");
  });

  it("redacts names, amounts and contacts in both note types and never returns financial rows or staff ids", async () => {
    const f = await package2Fixture(); const captured = await f.capture("private.person");
    await f.t.run(async ctx => {
      const note = "Alex Rivera and Dani Cruz said $3,000, USD 300 and 300 dollars. Email alice@gmail.com or +50499999912.";
      await noShow(ctx, f, captured.leadId!, { category: "other", note });
      await ctx.db.patch("leads", captured.leadId!, { contactAgain: { date: "2026-12-01", at: SHIFT_NOW + 86_400_000,
        timeZone: "America/Tegucigalpa", dayStartHour: 1, note, setByUserId: f.daniId, setAt: SHIFT_NOW } });
      await ctx.db.insert("domainEvents", { tenantId: f.tenantId, leadId: captured.leadId!, entityType: "payment", entityId: captured.leadId!, eventType: "payment.recorded", occurredAt: SHIFT_NOW, source: "pipeline" });
    });
    const result = toolData<Outcomes>(await f.tool(TOOL)); const json = JSON.stringify(result);
    for (const secret of ["Alex Rivera", "Dani Cruz", "alice@gmail.com", "+50499999912", "$3,000", "USD 300", "payment", f.closerId, f.daniId]) expect(json).not.toContain(secret);
    expect(json).toContain("[staff]"); expect(json).toContain("[amount]");
    expect(result.people[0].contactAgain?.note?.text).toContain("[staff]");
    expect(new TextEncoder().encode(json).byteLength).toBeLessThanOrEqual(65_536);
  });

  it("withholds notes for an oversized roster while keeping the no-show category", async () => {
    const f = await package2Fixture(); const captured = await f.capture("roster.person");
    await f.t.run(async ctx => {
      await noShow(ctx, f, captured.leadId!, { category: "technical_issues", note: "Alex Rivera" });
      for (let i = 0; i < 201; i++) await ctx.db.insert("teamMembers", { tenantId: f.tenantId, displayName: `Staff ${i}`, createdAt: 0, updatedAt: 0 });
    });
    expect(toolData<Outcomes>(await f.tool(TOOL)).people[0].noShows[0]).toMatchObject({ category: "technical_issues", note: null, withheld: "staff_roster_too_large" });
  });

  it("pages more than 25 people with no gaps and binds cursors to worker, tenant, stage, range and settings", async () => {
    const f = await package2Fixture();
    for (let i = 0; i < 31; i++) await f.capture(`paged.person${i}`);
    const first = toolData<Outcomes>(await f.tool(TOOL));
    expect(first.people).toHaveLength(25); expect(first.cursor).toBeTruthy();
    const second = toolData<Outcomes>(await f.tool(TOOL, { cursor: first.cursor }));
    expect(second.people).toHaveLength(6); expect(second.cursor).toBeNull();
    expect(new Set([...first.people, ...second.people].map(person => person.prospectId)).size).toBe(31);
    const other = await seedTenantWithLeadGen(f.t, { orgId: "org_other", slug: "other" });
    for (const agent of [await f.agent("user_dani"), await f.agent("other_user_sofia", other.orgId)]) {
      expect(toolData<Outcomes>(await agent(TOOL)).people).toEqual([]);
      expect((await agent(TOOL, { cursor: first.cursor })).isError).toBe(true);
    }
    for (const args of [{ stage: "qualified" }, { startDate: "2026-11-08", endDate: SHIFT_DAY }])
      expect((await f.tool(TOOL, { ...args, cursor: first.cursor })).isError).toBe(true);
    await f.t.run(ctx => ctx.db.patch("tenants", f.tenantId, { businessDayVersion: 1 }));
    expect((await f.tool(TOOL, { cursor: first.cursor })).isError).toBe(true);
  });

  it.each(["user_admin", "user_alex"])("refuses %s", async sub => {
    const f = await package2Fixture(); await f.capture("sofia.only"); const agent = await f.agent(sub);
    const result = await agent(TOOL); expect(result.response.body?.error?.message ?? result.text).toContain("isn't available for your role");
  });

  it("marks history partial for over ten deals or three calls, sorts ties, and caps child rows at 25", async () => {
    const f = await package2Fixture(); const a = await f.capture("many.deals"); const b = await f.capture("many.calls");
    await f.t.run(async ctx => {
      for (let i = 0; i < 11; i++) await noShow(ctx, f, a.leadId!, { createdAt: SHIFT_NOW + i, scheduledAt: SHIFT_NOW + i });
      const first = await noShow(ctx, f, b.leadId!, { scheduledAt: SHIFT_NOW, note: "one" });
      for (let i = 1; i < 30; i++) await noShow(ctx, f, b.leadId!, { opportunityId: first.opportunityId, scheduledAt: SHIFT_NOW + i, note: `call${i}` });
    });
    const rows = toolData<Outcomes>(await f.tool(TOOL)).people;
    expect(rows.every(row => row.historyPartial && row.noShows.length === 3)).toBe(true);
    expect(rows.find(row => row.handle === "many.calls")!.noShows[0].note?.text).toBe("call29");
    for (let i = 0; i < 23; i++) {
      const person = await f.capture(`more.history${i}`);
      await f.t.run(async ctx => { for (let j = 0; j < 3; j++) await noShow(ctx, f, person.leadId!, { note: "😀".repeat(700), scheduledAt: SHIFT_NOW + j }); });
    }
    const result = toolData<Outcomes>(await f.tool(TOOL));
    expect(result.people).toHaveLength(25);
    expect(result.people.reduce((sum, row) => sum + row.noShows.length, 0)).toBe(25);
    expect(result.people.every(row => row.historyPartial || row.noShows.length === 3)).toBe(true);
    expect(result.textTruncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(65_536);
  });

  it.each(["worker", "tenant", "missing", "merged", "key", "membership"])("fails closed for a stale %s entry", async mode => {
    const f = await package2Fixture(); const captured = await f.capture("stale.person");
    const other = await seedTenantWithLeadGen(f.t, { orgId: "org_other", slug: "other" });
    await f.t.run(async ctx => {
      if (mode === "worker") await ctx.db.patch("leadGenProspects", captured.prospectId, { firstCapturedByWorkerId: f.daniWorkerId });
      if (mode === "tenant") await ctx.db.patch("leads", captured.leadId!, { tenantId: other.tenantId });
      if (mode === "missing") await ctx.db.delete("leadGenProspects", captured.prospectId);
      if (mode === "merged") await ctx.db.patch("leads", captured.leadId!, { status: "merged" });
      if (mode === "key") await ctx.db.patch("leadGenProspects", captured.prospectId, { firstCapturedAt: SHIFT_NOW - 2000 });
      if (mode === "membership") await prospectConversions.insert(ctx, { namespace: f.tenantId, id: `${captured.prospectId}:qualified`, key: [f.sofiaWorkerId, "qualified", SHIFT_NOW - 3_600_000] });
    });
    const result = await f.tool(TOOL, mode === "membership" ? { stage: "qualified" } : {});
    expect(result.isError).toBe(true); expect(JSON.stringify(result.data)).not.toContain("stale.person");
  });

  it("budgets escaped notes by their serialized size without dropping cohort people", async () => {
    const f = await package2Fixture();
    for (let i = 0; i < 25; i++) {
      const captured = await f.capture(`escaped.person${i}`);
      await f.t.run(async ctx => {
        await noShow(ctx, f, captured.leadId!, { note: "\u0000".repeat(500) });
        await ctx.db.patch("leads", captured.leadId!, { contactAgain: { date: "2026-12-01", at: SHIFT_NOW + 86_400_000,
          timeZone: "America/Tegucigalpa", dayStartHour: 1, note: "\u0000".repeat(500), setByUserId: f.sofiaId, setAt: SHIFT_NOW } });
      });
    }
    const result = toolData<Outcomes>(await f.tool(TOOL));
    expect(result.people).toHaveLength(25); expect(result.textTruncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(65_536);
    expect(result.people.reduce((n, row) => n + row.noShows.length, 0)).toBe(25);
  });

  it("keeps multiple handles as separate report units for the same person", async () => {
    const f = await package2Fixture(); const first = await f.capture("first.handle"); const second = await f.capture("second.handle");
    await f.t.run(async ctx => {
      await ctx.db.patch("leadGenProspects", second.prospectId, { leadId: first.leadId! });
      const prospect = (await ctx.db.get("leadGenProspects", second.prospectId))!;
      await syncProspectConversions(ctx, prospect, await ctx.db.get("leads", first.leadId!));
      await noShow(ctx, f, first.leadId!, { note: "Shared history" });
    });
    const result = toolData<Outcomes>(await f.tool(TOOL));
    expect(result.counts.prospect).toBe(2); expect(result.people).toHaveLength(2);
    expect(result.people.every(row => row.noShows[0].note?.text === "Shared history")).toBe(true);
  });

  it("follows a corrected capture and refuses inactive workers without provisioning", async () => {
    const f = await package2Fixture(); const captured = await f.capture("void.person");
    await f.web("user_admin").mutation(api.leadGen.corrections.voidSubmission, { submissionId: captured.submissionId, reason: "Incorrect capture" });
    const conversions = await f.t.run(ctx => readProspectConversions(ctx, f.tenantId, { startDayKey: SHIFT_DAY, endDayKey: SHIFT_DAY }));
    expect(toolData<Outcomes>(await f.tool(TOOL)).counts).toEqual(conversions.rows.find(row => row.workerId === f.sofiaWorkerId)!.counts);
    await f.t.run(ctx => ctx.db.patch("leadGenWorkers", f.sofiaWorkerId, { isActive: false }));
    expect((await f.tool(TOOL)).isError).toBe(true);
  });
});
