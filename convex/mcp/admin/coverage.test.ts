/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { adminCaller, adminFixture } from "../../../tests/mcpAdminFixtures";
import { mcpRpc, testCaller } from "../../../tests/mcpHarness";
import { insertDeal } from "../../../tests/dealStageFixtures";
import { insertCloserMeeting } from "../../../tests/closerPipelineFixtures";
import { insertMeetingAggregate } from "../../reporting/writeHooks";
import { COVERAGE_READ_BUDGET, loadCoverageInput } from "../../unavailability/coverage";
import { localDateKey, parseLocalDateTime } from "../time";
import type { WriteFamily } from "../families";

/** `magnus_cover_closer` and its web-approved plan (admin assistant, commit 18). */

const TZ = "America/Tegucigalpa";
const HOUR = 3_600_000;
// Two days ahead, so every call is upcoming and the plan is still open.
const DATE = localDateKey(Date.now() + 2 * 24 * HOUR, TZ);
const NEXT_DATE = localDateKey(Date.now() + 3 * 24 * HOUR, TZ);
const at = (time: string, date = DATE) => parseLocalDateTime(date, time, TZ);

type Plan = { planId: Id<"mcpConfirmations">; approvalUrl: string; status: string; expiresAt: string };
type H = Awaited<ReturnType<typeof fixture>>;

async function fixture(families: WriteFamily[] = ["coverage"], extraClosers = 2) {
  const h = await adminFixture({ writeFamilies: families });
  const closers = await h.t.run(async (ctx) => {
    const ids: Id<"users">[] = [];
    for (let i = 0; i < extraClosers; i++) {
      ids.push(
        await ctx.db.insert("users", {
          tenantId: h.tenantId,
          workosUserId: `user_cover_${i}`,
          email: `cover${i}@northwind.example`,
          fullName: `Cover ${String.fromCharCode(65 + i)}`,
          role: "closer",
          isActive: true,
          timezone: TZ,
        }),
      );
    }
    return ids;
  });
  const caller = adminCaller(h.orgId);
  const cover = (args: Record<string, unknown>, who = caller) =>
    h.t.mutation(internal.mcp.admin.writes.coverage.prepareCoverCloser, {
      caller: who,
      closerId: h.closerId,
      date: DATE,
      fullDay: true,
      mode: "plan",
      ...args,
    } as never);
  const approve = (planId: Id<"mcpConfirmations">, web = h.adminWeb) => web.mutation(api.mcp.approvals.approvePlan, { planId });
  return { ...h, closers, caller, cover, approve };
}

/** A deal of `closerId`'s with a 30-minute meeting at each start. */
async function deal(h: H, starts: number[], closerId: Id<"users"> = h.closerId) {
  return await h.t.run(async (ctx) => {
    const dealId = await insertDeal(ctx, { tenantId: h.tenantId, status: "scheduled", fields: { assignedCloserId: closerId } });
    const meetingIds: Id<"meetings">[] = [];
    for (const scheduledAt of starts) {
      const meetingId = await insertCloserMeeting(ctx, { tenantId: h.tenantId, opportunityId: dealId, closerId, status: "scheduled", scheduledAt });
      await insertMeetingAggregate(ctx, meetingId);
      meetingIds.push(meetingId);
    }
    return { dealId, meetingIds };
  });
}

async function state(h: H) {
  return await h.t.run(async (ctx) => {
    const events = (await ctx.db.query("domainEvents").take(500)).filter((e) => e.eventType === "opportunity.reassigned");
    return {
      absences: await ctx.db.query("closerUnavailability").take(10),
      reassignments: await ctx.db.query("meetingReassignments").take(200),
      events: events.map((e) => ({ entityId: e.entityId, metadata: JSON.parse(e.metadata ?? "{}") as Record<string, unknown> })),
    };
  });
}

const ownerOf = (h: H, dealId: Id<"opportunities">) =>
  h.t.run(async (ctx) => {
    const d = await ctx.db.get("opportunities", dealId);
    const meetings = await ctx.db.query("meetings").withIndex("by_opportunityId", (q) => q.eq("opportunityId", dealId)).take(100);
    return { deal: d?.assignedCloserId, meetings: [...new Set(meetings.map((m) => m.assignedCloserId))] };
  });

/** Two deals: d1 has calls at 10:00 and 14:00, d2 at 10:00. Cover A is booked at 14:00. */
async function twoDeals(h: H) {
  const [a, b] = h.closers;
  const d1 = await deal(h, [at("10:00"), at("14:00")]);
  const d2 = await deal(h, [at("10:00")]);
  const busy = await deal(h, [at("14:00")], a);
  return { a, b, d1, d2, busy };
}

describe("magnus_cover_closer preview", () => {
  it("shows the calls and who is free, and writes nothing", async () => {
    const h = await fixture();
    const { a, b, d1, d2 } = await twoDeals(h);
    const out = (await h.cover({ mode: "preview" })) as {
      calls: Array<{ opportunityId: string; person: { by: string }; proposedOwner: { closerId: string } | null }>;
      candidates: Array<{ closerId: string; freeForDeals: number; of: number }>;
      openInMagnus: string;
    };
    expect(out.calls).toHaveLength(3);
    expect(out.calls.every((c) => c.person.by === "person")).toBe(true);
    expect(JSON.stringify(out)).not.toContain("@");
    // d1 needs a closer free at 10:00 and 14:00: only Cover B.
    const owners = Object.fromEntries(out.calls.map((c) => [c.opportunityId, c.proposedOwner?.closerId]));
    expect(owners).toEqual({ [d1.dealId]: b, [d2.dealId]: a });
    expect(out.candidates.find((c) => c.closerId === a)).toMatchObject({ freeForDeals: 1, of: 2 });
    expect(out.openInMagnus).toContain("/workspace/team");
    expect(await state(h)).toMatchObject({ absences: [], reassignments: [], events: [] });
    expect(await h.t.run((ctx) => ctx.db.query("mcpConfirmations").take(100))).toHaveLength(0);
  });
});

describe("coverage plans", () => {
  it("applies every deal on approval, one owner and one event per deal", async () => {
    const h = await fixture();
    const { a, b, d1, d2 } = await twoDeals(h);
    const plan = (await h.cover({ reason: "sick" })) as Plan;
    expect(plan.status).toBe("waiting_for_approval");
    expect(plan.approvalUrl).toContain(`/workspace/assistant/approvals/${plan.planId}`);
    const stored = await h.t.run((ctx) => ctx.db.get("mcpConfirmations", plan.planId));
    // Its first call is two days out, so the 24-hour limit applies.
    expect(stored!.expiresAt).toBe(stored!.createdAt! + 24 * HOUR);
    expect(JSON.parse(stored!.planJson!).columns).toEqual(["Person", "Call", "From", "To"]);
    expect(JSON.parse(stored!.planJson!).rows).toHaveLength(3);
    expect(await state(h)).toMatchObject({ absences: [], events: [] });

    const out = await h.approve(plan.planId);
    expect(out).toMatchObject({ status: "applied", reassignedDeals: 2, movedMeetings: 3 });
    expect(await ownerOf(h, d1.dealId)).toEqual({ deal: b, meetings: [b] });
    expect(await ownerOf(h, d2.dealId)).toEqual({ deal: a, meetings: [a] });
    const after = await state(h);
    expect(after.absences).toHaveLength(1);
    expect(after.absences[0]).toMatchObject({ closerId: h.closerId, isFullDay: true, reason: "sick", createdByUserId: h.adminId });
    expect(after.reassignments).toHaveLength(3);
    expect(after.events).toHaveLength(2);
    for (const e of after.events) {
      expect(e.metadata).toMatchObject({ via: "mcp", agentClient: "claude-ai", mode: "coverage_plan", fromCloserId: h.closerId });
    }
    expect(after.events.find((e) => e.entityId === d1.dealId)?.metadata).toMatchObject({ toCloserId: b, meetingIds: d1.meetingIds });
  });

  it("expires when its first upcoming call starts, counting calls that move with a deal but not past ones", async () => {
    const h = await fixture();
    const soon = Date.now() + 3 * HOUR;
    await deal(h, [at("10:00"), soon]);
    const past = await deal(h, [at("12:00")]);
    await h.t.run(async (ctx) => {
      const m = await insertCloserMeeting(ctx, { tenantId: h.tenantId, opportunityId: past.dealId, closerId: h.closerId, status: "held", scheduledAt: Date.now() - 2 * HOUR });
      await insertMeetingAggregate(ctx, m);
    });
    const plan = (await h.cover({})) as Plan;
    expect(Date.parse(plan.expiresAt)).toBe(soon);
  });

  it("is stale when a meeting is added to a deal after the plan", async () => {
    const h = await fixture();
    const { d2 } = await twoDeals(h);
    const plan = (await h.cover({})) as Plan;
    await h.t.run(async (ctx) => {
      const m = await insertCloserMeeting(ctx, { tenantId: h.tenantId, opportunityId: d2.dealId, closerId: h.closerId, status: "scheduled", scheduledAt: at("09:00", NEXT_DATE) });
      await insertMeetingAggregate(ctx, m);
    });
    expect(await h.approve(plan.planId)).toMatchObject({ status: "stale", written: 0 });
    expect(await state(h)).toMatchObject({ absences: [], reassignments: [], events: [] });
    expect((await ownerOf(h, d2.dealId)).deal).toBe(h.closerId);
  });

  it("is stale when a meeting moves or is resized", async () => {
    for (const change of [{ scheduledAt: at("11:00") }, { durationMinutes: 60 }]) {
      const h = await fixture();
      const { d1 } = await twoDeals(h);
      const plan = (await h.cover({})) as Plan;
      await h.t.run((ctx) => ctx.db.patch("meetings", d1.meetingIds[0], change));
      const out = (await h.approve(plan.planId)) as { status: string; changed: Array<{ field: string }> };
      expect(out).toMatchObject({ status: "stale", written: 0 });
      expect(out.changed[0].field).toContain(d1.meetingIds[0]);
      expect(await state(h)).toMatchObject({ absences: [], reassignments: [], events: [] });
    }
  });

  it("refuses with no writes when a target is booked after the plan", async () => {
    const h = await fixture();
    const { b, d1 } = await twoDeals(h);
    const plan = (await h.cover({})) as Plan;
    await deal(h, [at("14:10")], b);
    expect(await h.approve(plan.planId)).toMatchObject({ status: "refused", written: 0, code: "coverage.target_busy" });
    expect(await state(h)).toMatchObject({ absences: [], reassignments: [], events: [] });
    expect((await ownerOf(h, d1.dealId)).deal).toBe(h.closerId);
  });

  it("refuses the second of two competing plans for the same closer", async () => {
    const h = await fixture();
    await twoDeals(h);
    const first = (await h.cover({})) as Plan;
    const second = (await h.cover({}, adminCaller(h.orgId, "claude-ai", "user_owner"))) as Plan;
    expect(await h.approve(first.planId)).toMatchObject({ status: "applied" });
    const out = await h.approve(second.planId, h.ownerWeb);
    expect(out).toMatchObject({ written: 0 });
    expect((out as { status: string }).status).not.toBe("applied");
    const after = await state(h);
    expect(after.absences).toHaveLength(1);
    expect(after.events).toHaveLength(2);
  });

  it("refuses a plan when the closer already has an absence that day", async () => {
    const h = await fixture();
    await twoDeals(h);
    await h.t.run((ctx) =>
      ctx.db.insert("closerUnavailability", {
        tenantId: h.tenantId,
        closerId: h.closerId,
        date: at("00:00"),
        isFullDay: true,
        reason: "sick",
        createdByUserId: h.adminId,
        createdAt: Date.now(),
      }),
    );
    await expect(h.cover({})).rejects.toThrow(/redistribute/);
  });

  it("applies a plan at the cap inside one mutation, and refuses one past it", async () => {
    // 8 candidates, 25 deals, 50 meetings: each deal has a call in the window
    // and one the next day that moves with it.
    const h = await fixture(["coverage"], 8);
    const deals: Id<"opportunities">[] = [];
    for (let i = 0; i < 25; i++) {
      const minutes = 6 * 60 + i * 30;
      const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      deals.push((await deal(h, [at(time), at(time, NEXT_DATE)])).dealId);
    }
    const reads = await h.t.run(async (ctx) => {
      const input = await loadCoverageInput(ctx, {
        tenantId: h.tenantId,
        closerId: h.closerId,
        rangeStart: at("00:00"),
        rangeEnd: at("00:00") + 24 * HOUR,
        now: Date.now(),
      });
      if (!input.ok) throw new Error(input.message);
      return { reads: input.reads, deals: input.deals.length, meetings: input.deals.reduce((n, d) => n + d.meetings.length, 0), candidates: input.candidates.length };
    });
    expect(reads).toMatchObject({ deals: 25, meetings: 50, candidates: 8 });
    expect(reads.reads).toBeLessThan(COVERAGE_READ_BUDGET);

    const plan = (await h.cover({})) as unknown as Plan & { preview: { unassigned: unknown[] } };
    expect(plan.preview.unassigned).toEqual([]);
    expect(await h.approve(plan.planId)).toMatchObject({ status: "applied", reassignedDeals: 25, movedMeetings: 50 });
    const after = await state(h);
    expect(after.events).toHaveLength(25);
    expect(after.reassignments).toHaveLength(25);
    for (const id of deals) expect((await ownerOf(h, id)).deal).not.toBe(h.closerId);

    // A 51st meeting that would move with one of the deals is over the cap.
    const h2 = await fixture(["coverage"], 1);
    let last: Id<"opportunities"> | null = null;
    for (let i = 0; i < 25; i++) {
      last = (await deal(h2, [at(`${String(6 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`), at("09:00", NEXT_DATE)])).dealId;
    }
    await h2.t.run((ctx) =>
      insertCloserMeeting(ctx, { tenantId: h2.tenantId, opportunityId: last!, closerId: h2.closerId, status: "scheduled", scheduledAt: at("11:00", NEXT_DATE) }),
    );
    await expect(h2.cover({ mode: "preview" })).rejects.toThrow(/wizard/);
    expect(await h2.t.run((ctx) => ctx.db.query("mcpConfirmations").take(100))).toHaveLength(0);
  });
});

describe("access", () => {
  it("is hidden with the coverage family off, and a closer can't call it", async () => {
    const h = await fixture(["goals"]);
    const list = await mcpRpc(h.t, h.adminToken, "tools/list", {}, h.adminSession);
    const names = ((list.body?.result as { tools: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name);
    expect(names).toContain("magnus_set_goal");
    expect(names).not.toContain("magnus_cover_closer");
    await expect(h.cover({ mode: "preview" })).rejects.toThrow();

    const on = await fixture(["coverage"]);
    const onList = await mcpRpc(on.t, on.adminToken, "tools/list", {}, on.adminSession);
    expect(((onList.body?.result as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name)).toContain("magnus_cover_closer");
    await expect(on.cover({ mode: "preview" }, testCaller(on.orgId))).rejects.toThrow();
  });
});

describe("compared with the wizard", () => {
  it("picks the same closer where each deal has a single meeting", async () => {
    const h = await fixture();
    const [a, b] = h.closers;
    const { dealId, meetingIds } = await deal(h, [at("10:00")]);
    await deal(h, [at("10:15")], a);
    const preview = (await h.cover({ mode: "preview" })) as { calls: Array<{ proposedOwner: { closerId: string } | null }> };
    expect(preview.calls[0].proposedOwner?.closerId).toBe(b);
    const created = await h.adminWeb.mutation(api.unavailability.mutations.createCloserUnavailability, {
      closerId: h.closerId,
      date: at("00:00"),
      reason: "sick",
      isFullDay: true,
    });
    const wizard = await h.adminWeb.mutation(api.unavailability.redistribution.autoDistributeMeetings, {
      unavailabilityId: created.unavailabilityId,
      meetingIds,
      candidateCloserIds: h.closers,
    });
    expect(wizard.assigned.map((x) => x.toCloserId)).toEqual([b]);
    expect((await ownerOf(h, dealId)).deal).toBe(b);
  });
});
