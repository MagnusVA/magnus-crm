import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc } from "../../../_generated/dataModel";
import { internal } from "../../../_generated/api";
import { rebuildLeadCustomerSearchRow } from "../../../leadCustomers/projection";
import { initialLifecycleFields } from "../../../lib/leadLifecycle";
import { adminCaller, adminFixture } from "../../../../tests/mcpAdminFixtures";
import { insertDeal } from "../../../../tests/dealStageFixtures";
import { insertCloserMeeting } from "../../../../tests/closerPipelineFixtures";
import { insertCloserPayment, insertProgram } from "../../../../tests/closerPipelineDeskFixtures";
import { formatLocal } from "../../time";
import { rankPersonCandidates } from "./lookup";

const lookup = internal.mcp.admin.reads.lookup.run;
type Fixture = Awaited<ReturnType<typeof adminFixture>>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T18:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function person(f: Fixture, fields: Partial<Doc<"leads">>, won = false) {
  return f.t.run(async (ctx) => {
    const dealId = await insertDeal(ctx, {
      tenantId: f.tenantId,
      status: won ? "payment_received" : "scheduled",
      fields: { assignedCloserId: f.closerId },
    });
    const deal = (await ctx.db.get("opportunities", dealId))!;
    await ctx.db.patch("leads", deal.leadId, { email: undefined, ...fields });
    if (won) {
      const programId = await insertProgram(ctx, f.tenantId, f.ownerId, "Customer program");
      await ctx.db.insert("enrollments", { tenantId: f.tenantId, leadId: deal.leadId, programId, opportunityId: dealId, enrolledAt: 0, status: "active", createdAt: 0 });
    }
    await rebuildLeadCustomerSearchRow(ctx, f.tenantId, deal.leadId);
    return { leadId: deal.leadId, dealId };
  });
}
async function prospects(f: Fixture, count: number) {
  return f.t.run(async (ctx) => {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const handle = `brown_${i}`;
      const id = await ctx.db.insert("leads", {
        tenantId: f.tenantId, status: "active", firstSeenAt: 0, updatedAt: i,
        ...initialLifecycleFields({ stage: "in_conversation", at: 0 }),
        socialHandles: [{ type: "instagram", handle }], searchText: handle,
      });
      await rebuildLeadCustomerSearchRow(ctx, f.tenantId, id);
      ids.push(id);
    }
    return ids;
  });
}
function search(f: Fixture, query: string, kind: "person" | "deal" | "meeting" | "payment" | "team_member" = "person") {
  return f.t.query(lookup, { caller: adminCaller(f.orgId), kind, query });
}

describe("admin lookup person search", () => {
  it("finds the exact converted customer ahead of more than ten active token matches", async () => {
    const f = await adminFixture();
    for (let i = 0; i < 12; i++) await person(f, { fullName: `Reid Other ${i}`, searchText: `Reid Other ${i}` });
    const customer = await person(f, { fullName: "Reid Hall", searchText: "Reid Hall", status: "converted" }, true);
    const result = await search(f, "Reid Hall");
    expect(result.items[0].id).toBe(customer.leadId);
    expect(result.items).toHaveLength(10);
    expect(result.isPartial).toBe(true);
    expect(result.reason).toMatch(/narrow.*query|open Magnus/i);
    expect(result.reason).not.toMatch(/cursor/i);
  });

  it("ranks an exact active name above many handle-only prospects", async () => {
    const f = await adminFixture();
    await prospects(f, 14);
    const target = await person(f, { fullName: "Anthony Brown", searchText: "Anthony Brown" });
    const result = await search(f, " Anthony   Brown ");
    expect(result.items[0].id).toBe(target.leadId);
    expect(result.items).toHaveLength(10);
    expect(result.isPartial).toBe(true);
  });

  it("finds payments by a customer's name despite active token matches", async () => {
    const f = await adminFixture();
    for (let i = 0; i < 12; i++) await person(f, { fullName: `William Other ${i}`, searchText: `William Other ${i}` });
    const customer = await person(f, { fullName: "William Calhoun", searchText: "William Calhoun", status: "converted" }, true);
    const paymentId = await f.t.run(async (ctx) => {
      const programId = await insertProgram(ctx, f.tenantId, f.ownerId, "Coaching");
      return insertCloserPayment(ctx, { tenantId: f.tenantId, closerId: f.closerId, programId, opportunityId: customer.dealId, amountMinor: 10000 });
    });
    const result = await search(f, "William Calhoun", "payment");
    expect(result.items.map((r) => r.id)).toEqual([paymentId]);
  });

  it("resolves email exactly before full-text deal search", async () => {
    const f = await adminFixture();
    const email = "anthony@example.test";
    // A lexical match is not evidence that this person owns the identifier.
    await person(f, { fullName: "Ryan Brown", searchText: email });
    const target = await person(f, { fullName: "Anthony Brown", email, searchText: email });
    await f.t.run(async (ctx) => {
      await ctx.db.insert("leadIdentifiers", { tenantId: f.tenantId, leadId: target.leadId, type: "email", value: email, rawValue: email, source: "manual_entry", confidence: "verified", createdAt: 0 });
    });
    const result = await search(f, email, "deal");
    expect(result.items.map((r) => r.id)).toEqual([target.dealId]);
    expect((await search(f, " ANTHONY@EXAMPLE.TEST ", "deal")).items.map((r) => r.id)).toEqual([target.dealId]);
    expect((await search(f, "missing@example.test", "deal")).items).toEqual([]);
  });

  it.each(["", "   "])("rejects blank id %j with a structured selector error", async (id) => {
    const f = await adminFixture();
    await expect(f.t.query(lookup, { caller: adminCaller(f.orgId), kind: "person", id })).rejects.toMatchObject({ data: { code: "mcp.lookup_selector" } });
  });

  it("folds accents in team member name search", async () => {
    const f = await adminFixture();
    await f.t.run(async (ctx) => {
      const teamMemberId = await ctx.db.insert("teamMembers", { tenantId: f.tenantId, displayName: "Niña De Jesus", createdAt: 0, updatedAt: 0 });
      await ctx.db.patch("users", f.closerId, { fullName: "Niña De Jesus", teamMemberId });
    });
    expect((await search(f, "Nina", "team_member")).items).toMatchObject([{ title: { text: "Niña De Jesus" } }]);
  });

  it("shows past scheduled meetings as not_recorded with the current person name", async () => {
    const f = await adminFixture();
    const target = await person(f, { fullName: "Anthony Brown", searchText: "Anthony Brown" });
    const meetingId = await f.t.run(async (ctx) => insertCloserMeeting(ctx, { tenantId: f.tenantId, opportunityId: target.dealId, closerId: f.closerId, status: "scheduled", scheduledAt: Date.now() - 3600000 }));
    const result = await search(f, "Anthony Brown", "meeting");
    expect(result.items).toMatchObject([{ id: meetingId, state: "not_recorded", title: { text: "Anthony Brown" } }]);
    const direct = await f.t.query(lookup, { caller: adminCaller(f.orgId), kind: "meeting", id: meetingId });
    expect(direct.items[0].state).toBe("not_recorded");
  });

  it("distinguishes unnamed prospects without exposing identifiers", async () => {
    const f = await adminFixture();
    await prospects(f, 2);
    const result = await f.t.query(lookup, { caller: adminCaller(f.orgId), kind: "person", query: "brown", includeContact: true, includeNotes: true });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ title: { text: "Unnamed person" }, lifecycle: "prospect", dealCount: 0, latestActivityAt: formatLocal(0, "America/Tegucigalpa") });
    for (const item of result.items) {
      expect(item).not.toHaveProperty("contact");
      expect(item).not.toHaveProperty("notes");
    }
    expect(JSON.stringify(result)).not.toMatch(/brown_[01]|primaryIdentifier|email|phone/);
  });
});


describe("admin lookup identifier and ranking boundaries", () => {
  it("ranks accent-folded exact names, all tokens, some tokens and unnamed rows stably", () => {
    const rows = [
      { id: "unnamed" },
      { id: "some1", fullName: "Nina Brown" },
      { id: "all", fullName: "De Jesus Nina" },
      { id: "exact", fullName: "  Niña   De Jesus " },
      { id: "some2", fullName: "Other Jesus" },
    ];
    expect(rankPersonCandidates(rows, "nina de jesus").map((r) => r.id)).toEqual(["exact", "all", "some1", "some2", "unnamed"]);
    expect(rows[0].id).toBe("unnamed");
  });

  it("resolves normalized phone and Instagram identifiers without fuzzy matches", async () => {
    const f = await adminFixture();
    const target = await person(f, { fullName: "Anthony Brown", searchText: "Anthony Brown" });
    await f.t.run(async (ctx) => {
      for (const [type, value] of [["phone", "+14158675309"], ["instagram", "anthony.brown"]] as const) {
        await ctx.db.insert("leadIdentifiers", { tenantId: f.tenantId, leadId: target.leadId, type, value, rawValue: value, source: "manual_entry", confidence: "verified", createdAt: 0 });
      }
    });
    for (const query of ["(415) 867-5309", "@Anthony.Brown", "https://instagram.com/anthony.brown/", "anthony.brown"]) {
      expect((await search(f, query, "deal")).items.map((r) => r.id)).toEqual([target.dealId]);
    }
    expect((await search(f, "@unknown.brown", "deal")).items).toEqual([]);
  });

  it("resolves exact entity IDs without unrelated deals or newer meetings", async () => {
    const f = await adminFixture();
    const target = await person(f, { fullName: "Anthony Brown" });
    const meetingId = await f.t.run(async (ctx) => {
      const id = await insertCloserMeeting(ctx, { tenantId: f.tenantId, opportunityId: target.dealId, closerId: f.closerId, status: "held", scheduledAt: Date.now() - 86400000 });
      for (let i = 0; i < 12; i++) {
        await insertCloserMeeting(ctx, { tenantId: f.tenantId, opportunityId: target.dealId, closerId: f.closerId, status: "scheduled", scheduledAt: Date.now() + i * 3600000 });
      }
      await rebuildLeadCustomerSearchRow(ctx, f.tenantId, target.leadId);
      return id;
    });
    expect((await search(f, target.leadId)).items.map((r) => r.id)).toEqual([target.leadId]);
    expect((await search(f, target.dealId, "deal")).items.map((r) => r.id)).toEqual([target.dealId]);
    const result = await search(f, meetingId, "meeting");
    expect(result.items.map((r) => r.id)).toEqual([meetingId]);
    expect(result.isPartial).toBe(false);
    // A direct ID works without the projection, too.
    await f.t.run(async (ctx) => {
      const row = await ctx.db.query("leadCustomerSearchRows").withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", f.tenantId).eq("leadId", target.leadId)).unique();
      await ctx.db.delete("leadCustomerSearchRows", row!._id);
    });
    expect((await search(f, meetingId, "deal")).items.map((r) => r.id)).toEqual([target.dealId]);
  });

  it("never returns merged people and keeps ten visible matches ahead of prospects", async () => {
    const f = await adminFixture();
    const prospectIds = await prospects(f, 12);
    const merged = await person(f, { fullName: "Brown Merged", searchText: "Brown Merged", status: "merged" });
    const visible = [];
    for (let i = 0; i < 10; i++) visible.push(await person(f, { fullName: `Brown Person ${i}`, searchText: `Brown Person ${i}` }));
    const result = await search(f, "Brown");
    expect(result.items.map((r) => r.id)).toEqual(visible.map((r) => r.leadId));
    expect(result.items.map((r) => r.id)).not.toContain(merged.leadId);
    for (const id of prospectIds) expect(result.items.map((r) => r.id)).not.toContain(id);
  });
});
