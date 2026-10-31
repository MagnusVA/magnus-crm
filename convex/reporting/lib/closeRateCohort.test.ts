import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import schema from "../../schema";
import { convexTestModules } from "../../test.setup";
import { qualifiedLifecycle } from "../../../tests/bookingHarness";
import {
  closeRateCohortDealAt,
  closeRateOf,
  countCloseRateCohort,
  readCloseRateCohort,
  totalCloseRateTally,
} from "./closeRateCohort";

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 8, 14, 7);
const END = START + 3 * 24 * HOUR;
const range = { start: START, end: END };

async function insertTenant(ctx: MutationCtx, org: string) {
  return await ctx.db.insert("tenants", {
    businessDayAppliedVersion: 0,
    companyName: `Tenant ${org}`,
    contactEmail: `${org}@example.invalid`,
    workosOrgId: org,
    status: "active",
    inviteExpiresAt: START + 24 * HOUR,
    createdBy: "test",
  });
}

/**
 * One tenant's deals, each a case of the cohort rule, and another tenant's
 * won deal with a held call in the range.
 */
async function seed(ctx: MutationCtx) {
  const tenantId = await insertTenant(ctx, "org_a");
  const otherTenantId = await insertTenant(ctx, "org_b");
  const user = (forTenant: Id<"tenants">, workosUserId: string, fullName: string) =>
    ctx.db.insert("users", {
      tenantId: forTenant,
      workosUserId,
      email: `${workosUserId}@example.invalid`,
      role: "closer",
      fullName,
      isActive: true,
    });
  const carla = await user(tenantId, "closer_carla", "Carla");
  const beto = await user(tenantId, "closer_beto", "Beto");
  const outsider = await user(otherTenantId, "closer_other", "Other");
  const adminId = await ctx.db.insert("users", {
    tenantId,
    workosUserId: "admin",
    email: "admin@example.invalid",
    role: "tenant_admin",
    isActive: true,
  });
  const program = (name: string) =>
    ctx.db.insert("tenantPrograms", {
      tenantId,
      name,
      normalizedName: name.toLowerCase(),
      createdAt: START,
      updatedAt: START,
      createdByUserId: adminId,
    });
  const mentorship = await program("Mentorship");
  const coaching = await program("Coaching");

  const deal = async (
    forTenant: Id<"tenants">,
    assignedCloserId: Id<"users">,
    outcome: Doc<"opportunities">["outcome"],
  ) => {
    const leadId = await ctx.db.insert("leads", {
      ...qualifiedLifecycle(START),
      tenantId: forTenant,
      fullName: "Lead",
      firstSeenAt: START,
      updatedAt: START,
      status: "active",
    });
    return await ctx.db.insert("opportunities", {
      tenantId: forTenant,
      leadId,
      stage: outcome === "open" ? "call_held" : "closed",
      outcome,
      assignedCloserId,
      createdAt: START,
      updatedAt: START,
    });
  };
  let meetingIndex = 0;
  const meeting = (
    forTenant: Id<"tenants">,
    opportunityId: Id<"opportunities">,
    assignedCloserId: Id<"users">,
    scheduledAt: number,
    status: Doc<"meetings">["status"],
    bookingProgramId?: Id<"tenantPrograms">,
  ) => {
    meetingIndex += 1;
    return ctx.db.insert("meetings", {
      tenantId: forTenant,
      opportunityId,
      assignedCloserId,
      calendlyEventUri: `https://example.invalid/event/${meetingIndex}`,
      calendlyInviteeUri: `https://example.invalid/invitee/${meetingIndex}`,
      scheduledAt,
      durationMinutes: 30,
      status,
      createdAt: scheduledAt - 24 * HOUR,
      ...(bookingProgramId ? { bookingProgramId, bookingProgramName: "Program" } : {}),
    });
  };

  // First held call before the range: out, though it has one in the range.
  const early = await deal(tenantId, carla, "won");
  await meeting(tenantId, early, carla, START - HOUR, "held", mentorship);
  await meeting(tenantId, early, carla, START + 2 * HOUR, "held", mentorship);
  // Two held calls in the range, then reassigned: counted once, credited to
  // the first call's closer and program.
  const twice = await deal(tenantId, beto, "won");
  const twiceFirst = await meeting(tenantId, twice, carla, START + HOUR, "held", mentorship);
  await meeting(tenantId, twice, beto, START + 30 * HOUR, "held", coaching);
  // Open and lost deals: in the cohort, not won.
  const open = await deal(tenantId, beto, "open");
  await meeting(tenantId, open, beto, START + 4 * HOUR, "no_show");
  await meeting(tenantId, open, beto, START + 26 * HOUR, "held");
  const lost = await deal(tenantId, beto, "lost");
  await meeting(tenantId, lost, beto, START + 50 * HOUR, "held", coaching);
  // Never held: no-show and canceled calls don't join the cohort.
  const missed = await deal(tenantId, carla, "lost");
  await meeting(tenantId, missed, carla, START + 3 * HOUR, "no_show", mentorship);
  await meeting(tenantId, missed, carla, START + 27 * HOUR, "canceled", mentorship);
  // First held call after the range.
  const later = await deal(tenantId, carla, "won");
  await meeting(tenantId, later, carla, END + HOUR, "held", mentorship);
  // Another tenant's won deal, held in the range.
  const foreign = await deal(otherTenantId, outsider, "won");
  await meeting(otherTenantId, foreign, outsider, START + 5 * HOUR, "held");

  return { tenantId, carla, beto, mentorship, coaching, twice, twiceFirst, open, lost };
}

function byOpportunity<T extends { opportunityId: string }>(rows: T[]) {
  return [...rows].sort((left, right) => left.opportunityId.localeCompare(right.opportunityId));
}

describe("readCloseRateCohort", () => {
  it("counts each deal once, at its first held call in the range", async () => {
    const t = convexTest({ schema, modules: convexTestModules });
    await t.run(async (ctx) => {
      const fixture = await seed(ctx);
      const result = await readCloseRateCohort(ctx, fixture.tenantId, range);

      expect(result.capped).toBe(false);
      expect(result.deals).toHaveLength(3);
      const deal = new Map(result.deals.map((row) => [row.opportunityId, row]));
      expect(deal.get(fixture.twice)).toEqual({
        opportunityId: fixture.twice,
        firstHeldMeetingId: fixture.twiceFirst,
        firstHeldAt: START + HOUR,
        closerId: fixture.carla,
        bookingProgramId: fixture.mentorship,
        won: true,
      });
      expect(deal.get(fixture.open)).toMatchObject({ closerId: fixture.beto, bookingProgramId: null, won: false });
      expect(deal.get(fixture.lost)).toMatchObject({ closerId: fixture.beto, bookingProgramId: fixture.coaching, won: false });

      const counts = countCloseRateCohort(result.deals);
      expect(counts).toHaveLength(3);
      expect(counts).toEqual(expect.arrayContaining([
        { closerId: fixture.carla, bookingProgramId: fixture.mentorship, cohortDeals: 1, wonDeals: 1 },
        { closerId: fixture.beto, bookingProgramId: null, cohortDeals: 1, wonDeals: 0 },
        { closerId: fixture.beto, bookingProgramId: fixture.coaching, cohortDeals: 1, wonDeals: 0 },
      ]));
      expect(closeRateOf(totalCloseRateTally(counts))).toBeCloseTo(1 / 3);
    });
  });

  it("keeps a closer's own first held calls with the closerId option", async () => {
    const t = convexTest({ schema, modules: convexTestModules });
    await t.run(async (ctx) => {
      const fixture = await seed(ctx);
      // Beto held a call on the reassigned deal too, but its first was Carla's.
      const beto = await readCloseRateCohort(ctx, fixture.tenantId, range, { closerId: fixture.beto });
      expect(beto.deals.map((deal) => deal.opportunityId).sort()).toEqual([fixture.open, fixture.lost].sort());
      const carla = await readCloseRateCohort(ctx, fixture.tenantId, range, { closerId: fixture.carla });
      expect(carla.deals.map((deal) => deal.opportunityId)).toEqual([fixture.twice]);
    });
  });

  it("answers capped with no deals when a bound is hit", async () => {
    const t = convexTest({ schema, modules: convexTestModules });
    await t.run(async (ctx) => {
      const fixture = await seed(ctx);
      expect(await readCloseRateCohort(ctx, fixture.tenantId, range, { maxHeldMeetings: 1 }))
        .toEqual({ deals: [], capped: true });
      expect(await readCloseRateCohort(ctx, fixture.tenantId, range, { byteBudget: 1 }))
        .toEqual({ deals: [], capped: true });
    });
  });

  it("finds the same deals meeting by meeting, as the report job reads them", async () => {
    const t = convexTest({ schema, modules: convexTestModules });
    await t.run(async (ctx) => {
      const fixture = await seed(ctx);
      const held = await ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
          q.eq("tenantId", fixture.tenantId).eq("status", "held").gte("scheduledAt", START).lt("scheduledAt", END),
        )
        .take(100);
      const deals = [];
      for (const meeting of held) {
        const deal = await closeRateCohortDealAt(ctx, fixture.tenantId, meeting);
        if (deal) deals.push(deal);
      }
      const live = await readCloseRateCohort(ctx, fixture.tenantId, range);
      expect(byOpportunity(deals)).toEqual(byOpportunity(live.deals));
    });
  });
});
