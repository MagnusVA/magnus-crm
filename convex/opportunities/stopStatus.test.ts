import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  changeMissedMeetingLoss,
  missedMeetingLoss,
  transitionOpportunity,
} from "../lib/opportunityActivity";
import { bucketKey, meetingDayKey } from "../operations/meetingStats";
import { opportunityByStage, opportunityByStatus } from "../reporting/aggregates";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { insertDealTask } from "../../tests/dealStateFixtures";
import { countAtStage, harnessCloserId, insertDeal } from "../../tests/dealStageFixtures";
import {
  book,
  enrollmentHarness,
  sideDeal,
  type EnrollmentHarness,
} from "../../tests/enrollmentFixtures";
import {
  expectClear,
  expectNoStatusCopies,
  qualifyInSlack,
  statusCopies,
  withPr8StatusCopies,
} from "../../tests/stopStatusFixtures";
import { DEAL_POSITIONS, dealPosition, stageOfPosition } from "./stages";

// Phase 5 PR 9 (docs/plans/phase-5-deal-status.md §9, §10.6): nothing writes
// `opportunities.status` or any copy of it, `opportunityByStage` is on its
// strict methods, and the clears unset what PR 8 left.

afterEach(() => vi.useRealTimers());

const NOW = Date.parse("2026-10-20T12:00:00Z");

async function move(
  harness: EnrollmentHarness,
  opportunityId: Id<"opportunities">,
  transition: Omit<Parameters<typeof transitionOpportunity>[2], "source">,
) {
  await harness.t.run((ctx) => transitionOpportunity(ctx, opportunityId, { source: "system", ...transition }));
}

async function readDeal(harness: EnrollmentHarness, opportunityId: Id<"opportunities">) {
  return (await harness.t.run((ctx) => ctx.db.get("opportunities", opportunityId)))!;
}

describe("no write path writes the status or a copy of it", () => {
  it("a Calendly booking", async () => {
    const harness = await enrollmentHarness();
    const { opportunityId } = await book(harness, "cold");

    expect(await readDeal(harness, opportunityId)).toMatchObject({ stage: "booked", outcome: "open" });
    await expectNoStatusCopies(harness);
  });

  it("a Slack qualification, with its qualification row on the stage", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await qualifyInSlack(harness);

    expect(await readDeal(harness, opportunityId)).toMatchObject({ stage: "qualified", outcome: "open" });
    const rows = await harness.t.run((ctx) => ctx.db.query("operationsQualificationRows").take(10));
    expect(rows.map((row) => [row.dealStage, row.dealOutcome])).toEqual([["qualified", "open"]]);
    expect(rows[0].searchText).not.toContain("qualified_pending");
    await expectNoStatusCopies(harness);
  });

  it("a side deal, and deleting it", async () => {
    const harness = await enrollmentHarness();
    const { opportunityId } = await sideDeal(harness, "side", { email: "side@example.com" });
    expect(await readDeal(harness, opportunityId)).toMatchObject({ stage: "call_held", outcome: "open" });
    await expectNoStatusCopies(harness);

    await harness.closer.mutation(api.sideDeals.deleteEmptyOpportunity.deleteEmptyOpportunity, { opportunityId });
    await expectNoStatusCopies(harness);
  });

  it("every kind of move: a missed meeting, Calendly's flip, a next step, a booking, a win", async () => {
    const harness = await enrollmentHarness();
    const { opportunityId } = await book(harness, "moves");

    await move(harness, opportunityId, {
      to: { stage: "closed", outcome: "lost" },
      fields: missedMeetingLoss("no_show", NOW),
      occurredAt: NOW,
    });
    await harness.t.run((ctx) =>
      changeMissedMeetingLoss(ctx, opportunityId, {
        reason: "canceled",
        at: NOW + 1,
        fields: { canceledAt: NOW + 1 },
        source: "pipeline",
      }),
    );
    await move(harness, opportunityId, { to: { stage: "follow_up" }, exception: "missed_meeting_next_step" });
    await move(harness, opportunityId, { to: { stage: "booked" } });
    await move(harness, opportunityId, { to: { stage: "closed", outcome: "won" } });

    expect(await readDeal(harness, opportunityId)).toMatchObject({ stage: "closed", outcome: "won" });
    await expectNoStatusCopies(harness);
  });

  it("a stage change doesn't re-project the deal's meetings, which carry no deal field", async () => {
    const harness = await enrollmentHarness();
    const { opportunityId, meetingId } = await book(harness, "projection");
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
    const projection = () =>
      harness.t.run(async (ctx) =>
        (await ctx.db
          .query("meetingProjections")
          .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
          .unique())!,
      );
    const before = await projection();

    await move(harness, opportunityId, { to: { stage: "follow_up" } });
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await harness.t.run((ctx) => ctx.db.query("opportunityProjectionJobs").take(10))).toEqual([]);
    const after = await projection();
    expect(after.generation).toBe(before.generation);
    // The key names the day, the closer, both programs and the attendance.
    const meeting = (await harness.t.run((ctx) => ctx.db.get("meetings", meetingId)))!;
    expect(JSON.parse(after.bucketKey!)).toEqual([
      meetingDayKey(meeting.scheduledAt),
      meeting.assignedCloserId,
      meeting.bookingProgramId ?? null,
      null,
      "scheduled",
    ]);
  });

  it("leaves a status PR 8 stored as it is, for the clear", async () => {
    const harness = await enrollmentHarness();
    const { opportunityId } = await book(harness, "stale");
    await harness.t.run((ctx) => withPr8StatusCopies(ctx, harness.tenantId, "scheduled"));
    const before = await harness.t.run((ctx) => statusCopies(ctx, harness.tenantId));

    await move(harness, opportunityId, { to: { stage: "closed", outcome: "won" } });
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await readDeal(harness, opportunityId)).toMatchObject({ status: "scheduled", stage: "closed", outcome: "won" });
    expect(await harness.t.run((ctx) => statusCopies(ctx, harness.tenantId))).toEqual(before);
    const stats = await harness.t.run((ctx) => ctx.db.query("tenantStats").first());
    expect(stats).toMatchObject({ activeOpportunities: 1, wonDeals: 0, lostDeals: 0 });
  });
});

describe("opportunityByStage, on its strict methods", () => {
  it("holds each deal once, at its stage, as it moves", async () => {
    const harness = await enrollmentHarness();
    const first = await book(harness, "first", "first@example.com");
    await book(harness, "second", "second@example.com");
    await sideDeal(harness, "side", { email: "side@example.com" });
    await move(harness, first.opportunityId, { to: { stage: "follow_up" } });
    await move(harness, first.opportunityId, { to: { stage: "closed", outcome: "won" } });

    const counted = await harness.t.run(async (ctx) => {
      const deals = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", harness.tenantId))
        .take(20);
      return await Promise.all(
        DEAL_POSITIONS.map(async (position) => {
          const { stage, outcome } = stageOfPosition(position);
          return {
            position,
            aggregate: await countAtStage(ctx, harness.tenantId, stage, outcome),
            table: deals.filter((deal) => dealPosition(deal.stage!, deal.outcome!) === position).length,
          };
        }),
      );
    });
    expect(counted.map(({ position, table }) => ({ position, aggregate: table }))).toEqual(
      counted.map(({ position, aggregate }) => ({ position, aggregate })),
    );
    expect(counted.find((row) => row.position === "won")?.aggregate).toBe(1);
    expect(await harness.t.run((ctx) => opportunityByStage.count(ctx, { namespace: harness.tenantId }))).toBe(3);
  });

  it("refuses to move a deal it doesn't hold, and writes nothing", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await harness.t.run(async (ctx) => {
      const id = await insertDeal(ctx, { tenantId: harness.tenantId, status: "scheduled", fields: { assignedCloserId: await harnessCloserId(ctx) } });
      await opportunityByStage.delete(ctx, (await ctx.db.get("opportunities", id))!);
      return id;
    });
    const before = await readDeal(harness, opportunityId);

    await expect(move(harness, opportunityId, { to: { stage: "follow_up" } })).rejects.toThrow();
    expect(await readDeal(harness, opportunityId)).toEqual(before);
  });

  it("refuses to enter a deal twice", async () => {
    const harness = await enrollmentHarness();
    const { opportunityId } = await book(harness, "twice");
    await expect(harness.t.run((ctx) => insertOpportunityAggregate(ctx, opportunityId))).rejects.toThrow();
  });

  it("keys a deal by its stored stage and outcome only, never its status", async () => {
    const harness = await enrollmentHarness();
    const { leadId } = await book(harness, "keyless");
    // A deal with only a status, which no write leaves.
    const opportunityId = await harness.t.run((ctx) =>
      ctx.db.insert("opportunities", {
        tenantId: harness.tenantId,
        leadId,
        status: "scheduled",
        source: "calendly",
        createdAt: 1_000,
        updatedAt: 1_000,
      }),
    );
    await expect(harness.t.run((ctx) => insertOpportunityAggregate(ctx, opportunityId))).rejects.toThrow(
      /no stage/,
    );
  });
});

describe("assertDealStages, with no status comparison", () => {
  it("passes on a deal with no status and on one whose stored status is stale", async () => {
    const harness = await enrollmentHarness();
    await book(harness, "plain", "plain@example.com");
    const { opportunityId } = await book(harness, "stale", "stale@example.com");
    await harness.t.run(async (ctx) => {
      // eslint-disable-next-line no-restricted-syntax -- the status PR 8 left on a deal PR 9 moved
      await ctx.db.patch("opportunities", opportunityId, { status: "payment_received" });
    });

    expect((await harness.run("assertDealStages"))?.error).toBeUndefined();
  });

  it("names a deal with a pending reschedule link off Follow-up", async () => {
    const harness = await enrollmentHarness();
    const { opportunityId } = await book(harness, "link");
    await harness.t.run((ctx) => insertDealTask(ctx, opportunityId));

    expect((await harness.run("assertDealStages"))?.error).toContain(`Opportunity ${opportunityId}`);
  });
});

describe("the clears", () => {
  async function pr8Tenant() {
    const harness = await enrollmentHarness();
    await book(harness, "one", "one@example.com");
    await book(harness, "two", "two@example.com");
    await qualifyInSlack(harness);
    await harness.t.run((ctx) => withPr8StatusCopies(ctx, harness.tenantId));
    return harness;
  }

  it("clearDealStatus unsets every deal's status, and the stage assert still passes", async () => {
    const harness = await pr8Tenant();
    await expectClear(harness, {
      clear: "clearDealStatus",
      assert: "assertDealStatusCleared",
      table: "opportunities",
      field: "status",
    });
    expect((await harness.rerun("assertDealStages"))?.error).toBeUndefined();
  });

  it("clearOpportunitySearchStatus unsets every search row's status", async () => {
    await expectClear(await pr8Tenant(), {
      clear: "clearOpportunitySearchStatus",
      assert: "assertOpportunitySearchStatusCleared",
      table: "opportunitySearch",
      field: "status",
    });
  });

  it("clearMeetingOpportunityStatus unsets every meeting's copy", async () => {
    await expectClear(await pr8Tenant(), {
      clear: "clearMeetingOpportunityStatus",
      assert: "assertMeetingOpportunityStatusCleared",
      table: "meetings",
      field: "opportunityStatus",
    });
  });

  it("clearQualificationRowStatus unsets every qualification row's copy", async () => {
    const harness = await pr8Tenant();
    await expectClear(harness, {
      clear: "clearQualificationRowStatus",
      assert: "assertQualificationRowStatusCleared",
      table: "operationsQualificationRows",
      field: "opportunityStatus",
    });
    expect((await harness.run("assertQualificationRowsCurrent"))?.error).toBeUndefined();
  });

  it("clearLegacyDailyStatsStatus unsets the legacy daily rows' copy", async () => {
    await expectClear(await pr8Tenant(), {
      clear: "clearLegacyDailyStatsStatus",
      assert: "assertLegacyDailyStatsStatusCleared",
      table: "operationsMeetingDailyStats",
      field: "opportunityStatus",
    });
  });

  it("clearOpportunityByStatus counts on a dry run, then empties each tenant's namespace", async () => {
    const harness = await pr8Tenant();
    const count = () => harness.t.run((ctx) => opportunityByStatus.count(ctx, { namespace: harness.tenantId }));
    expect(await count()).toBe(3);

    expect(await harness.t.mutation(internal.migrations.clearOpportunityByStatus, { dryRun: true })).toEqual({
      namespaces: 1, entries: 3, cleared: false,
    });
    expect(await count()).toBe(3);
    expect(await harness.t.mutation(internal.migrations.clearOpportunityByStatus, {})).toEqual({
      namespaces: 1, entries: 3, cleared: true,
    });
    expect(await count()).toBe(0);
    expect(await harness.t.mutation(internal.migrations.clearOpportunityByStatus, {})).toMatchObject({ entries: 0 });
    // opportunityByStage is another component and keeps every deal.
    expect(await harness.t.run((ctx) => opportunityByStage.count(ctx, { namespace: harness.tenantId }))).toBe(3);
  });

  it("clearTenantStatusCounters counts on a dry run, then unsets the three counters", async () => {
    const harness = await pr8Tenant();
    const stats = () => harness.t.run(async (ctx) => (await ctx.db.query("tenantStats").first())!);
    const before = await stats();

    expect(await harness.t.mutation(internal.migrations.clearTenantStatusCounters, { dryRun: true })).toEqual({
      rows: 1, cleared: false,
    });
    expect(await stats()).toEqual(before);
    expect(await harness.t.mutation(internal.migrations.clearTenantStatusCounters, {})).toEqual({
      rows: 1, cleared: true,
    });
    const { activeOpportunities: _active, wonDeals: _won, lostDeals: _lost, ...rest } = before;
    expect(await stats()).toEqual(rest);
    expect(await harness.t.mutation(internal.migrations.clearTenantStatusCounters, {})).toEqual({
      rows: 0, cleared: true,
    });
  });

  it("rebuildMeetingProjections re-keys a projection PR 8 keyed by the deal status, and its asserts pass", async () => {
    const harness = await enrollmentHarness();
    const { meetingId } = await book(harness, "rekey");
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
    // As PR 8 left it: the contribution and its bucket carry the status, in
    // the key's old format.
    const oldKey = await harness.t.run(async (ctx) => {
      const projection = (await ctx.db
        .query("meetingProjections")
        .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
        .unique())!;
      const contribution = { ...projection.contribution!, opportunityStatus: "scheduled" as const };
      const key = JSON.stringify([
        contribution.dayKey,
        contribution.assignedCloserId,
        contribution.bookingProgramId ?? null,
        contribution.soldProgramId ?? null,
        "scheduled",
        contribution.meetingStatus,
      ]);
      await ctx.db.patch("meetingProjections", projection._id, { contribution, bucketKey: key });
      const bucket = (await ctx.db.query("operationsMeetingStatsV2").first())!;
      await ctx.db.patch("operationsMeetingStatsV2", bucket._id, { opportunityStatus: "scheduled", bucketKey: key });
      return key;
    });
    expect((await harness.run("assertMeetingProjections"))?.error).toBeDefined();
    expect((await harness.run("assertMeetingProjectionSources"))?.error).toBeDefined();

    expect((await harness.run("rebuildMeetingProjections"))?.error).toBeUndefined();
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

    const buckets = await harness.t.run((ctx) => ctx.db.query("operationsMeetingStatsV2").take(10));
    expect(buckets.map((bucket) => bucket.bucketKey)).not.toContain(oldKey);
    expect(buckets.map((bucket) => ({ count: bucket.count, status: bucket.opportunityStatus }))).toEqual([
      { count: 1, status: undefined },
    ]);
    const projection = await harness.t.run((ctx) =>
      ctx.db.query("meetingProjections").withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId)).unique(),
    );
    expect(projection?.bucketKey).toBe(bucketKey(projection!.contribution!));
    expect((await harness.rerun("assertMeetingProjections"))?.error).toBeUndefined();
    expect((await harness.rerun("assertMeetingProjectionSources"))?.error).toBeUndefined();
    expect((await harness.run("assertMeetingProjectionBuckets"))?.error).toBeUndefined();
    await expectNoStatusCopies(harness);
  });
});
