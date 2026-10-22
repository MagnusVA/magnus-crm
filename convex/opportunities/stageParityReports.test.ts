import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import { forceOpportunityState } from "../../tests/opportunityFixtures";
import {
  LOSS_RANGE,
  MEETING_RANGE,
  closerAOutcomes,
  closerBOutcomes,
  noPositions,
  runToEnd,
  seededParityHarness,
} from "../../tests/stageParityFixtures";

// The parity queries (docs/plans/phase-5-deal-status.md §10.4): no difference
// on consistent deals, each planted difference reported with its IDs, and the
// paged runs ending with the same comparison as one call.

afterEach(() => vi.useRealTimers());

const seeded = seededParityHarness;

describe("compareStageCounts", () => {
  it("finds no difference tenant-wide or for any closer on consistent deals", async () => {
    const { harness } = await seeded();
    const page = await harness.t.query(internal.opportunities.stageParity.compareStageCounts, {
      tenantId: harness.tenantId,
    });

    expect(page.isDone).toBe(true);
    expect(page.continueCursor).toBeNull();
    expect(page.ok).toBe(true);
    expect(page.differences).toEqual([]);
    expect(page.tenant?.positions).toEqual({ qualified: 1, booked: 2, call_held: 1, follow_up: 2, won: 2, lost: 7 });
    expect(page.tenant?.total).toEqual({ byStage: 15, byStatus: 15 });
    expect(page.closers.map(({ closerId }) => closerId)).toEqual([harness.closerAId, harness.closerBId]);
    expect(page.closers[0]?.positions).toEqual({ ...noPositions, booked: 1, call_held: 1, follow_up: 1, won: 1, lost: 3 });
    expect(page.closers[0]?.statuses.canceled).toBe(1);
    expect(page.dealsScanned).toBe(13);
  });

  it("reports a deal whose stage doesn't match its status", async () => {
    const { harness, seed } = await seeded();
    await harness.t.run((ctx) => forceOpportunityState(ctx, seed.deals.bookedStale, { stage: "follow_up", outcome: "open" }));

    const page = await harness.t.query(internal.opportunities.stageParity.compareStageCounts, {
      tenantId: harness.tenantId,
    });

    expect(page.ok).toBe(false);
    expect(page.differences).toEqual([
      { closerId: null, positions: ["booked", "call_held"], statuses: ["scheduled"], byStage: 2, byStatus: 3 },
      {
        closerId: null,
        positions: ["follow_up"],
        statuses: ["follow_up_scheduled", "reschedule_link_sent"],
        byStage: 3,
        byStatus: 2,
      },
      { closerId: harness.closerAId, positions: ["booked", "call_held"], statuses: ["scheduled"], byStage: 1, byStatus: 2 },
      {
        closerId: harness.closerAId,
        positions: ["follow_up"],
        statuses: ["follow_up_scheduled", "reschedule_link_sent"],
        byStage: 2,
        byStatus: 1,
      },
    ]);
  });

  it("pages over the closers and ends with the whole comparison", async () => {
    const { harness } = await seeded();
    const whole = await harness.t.query(internal.opportunities.stageParity.compareStageCounts, {
      tenantId: harness.tenantId,
    });
    const { last, calls } = await runToEnd(harness.t, internal.opportunities.stageParity.compareStageCounts, {
      tenantId: harness.tenantId,
      docBudget: 1,
    });

    expect(calls).toBe(2);
    expect(last.ok).toBe(true);
    expect(last.tenant).toEqual(whole.tenant);
    expect(last.closers).toEqual(whole.closers);
    expect(last.dealsScanned).toBe(whole.dealsScanned);
  });
});

describe("comparePipelineHealth", () => {
  it("finds no difference in aging, the stale list, velocity or loss attribution", async () => {
    const { harness, seed } = await seeded();
    const page = await harness.t.query(internal.opportunities.stageParity.comparePipelineHealth, {
      tenantId: harness.tenantId,
      ...LOSS_RANGE,
    });

    expect(page.isDone).toBe(true);
    expect(page.differences).toEqual([]);
    expect(page.ok).toBe(true);
    expect(page.aging.byStatus.scheduled).toEqual({ count: 3, averageAgeDays: 53 / 3, oldestAgeDays: 40 });
    // The expected difference: Scheduled is Booked plus the side deal's Call held.
    expect(page.aging.byStage.booked).toEqual({ count: 2, averageAgeDays: 21.5, oldestAgeDays: 40 });
    expect(page.aging.byStage.call_held).toEqual({ count: 1, averageAgeDays: 10, oldestAgeDays: 10 });
    expect(page.aging.staleCount).toEqual({ byStatus: 4, byStage: 4 });
    expect(page.aging.staleTop.byStage.map((row) => row.opportunityId)).toEqual([
      seed.deals.bookedStale,
      seed.deals.linkSent,
      seed.deals.sideDeal,
      seed.deals.qualified,
    ]);
    expect(page.aging.staleTop.byStatus).toEqual(page.aging.staleTop.byStage);
    expect(page.aging.scanned.byStage.docs).toBe(6);
    expect(page.aging.scanned.byStatus.docs).toBe(6);
    expect(page.aging.scanned.byStage.bytes).toBeGreaterThan(0);
    expect(page.velocity).toEqual({
      byStatus: { velocityDays: 5, wonCount: 1, truncated: false },
      byStage: { velocityDays: 5, wonCount: 1, truncated: false },
    });
    expect(page.lossAttribution?.byStage).toEqual({
      count: 3,
      unknown: 1,
      byActor: [
        { userId: harness.adminId, count: 1 },
        { userId: harness.closerAId, count: 1 },
      ].sort((left, right) => left.userId.localeCompare(right.userId)),
      truncated: false,
      scanned: 6,
    });
    expect(page.lossAttribution?.byStatus).toEqual({ ...page.lossAttribution?.byStage, scanned: 4 });
  });

  it("reports the deals behind a planted difference", async () => {
    const { harness, seed } = await seeded();
    await harness.t.run(async (ctx) => {
      // A won deal whose stage says Booked, and a missed meeting's loss with a person on it.
      await forceOpportunityState(ctx, seed.deals.won, { stage: "booked", outcome: "open" });
      await ctx.db.patch("opportunities", seed.deals.noShow, { lostByUserId: harness.closerBId });
    });

    const page = await harness.t.query(internal.opportunities.stageParity.comparePipelineHealth, {
      tenantId: harness.tenantId,
      ...LOSS_RANGE,
    });

    expect(page.ok).toBe(false);
    expect(page.differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "aging_deals", key: "booked_or_call_held", opportunityIds: [seed.deals.won] }),
        expect.objectContaining({ check: "aging_count", key: "booked_or_call_held", byStatus: 3, byStage: 4 }),
        expect.objectContaining({ check: "stale_count", byStatus: 4, byStage: 5 }),
        expect.objectContaining({ check: "velocity_deals", opportunityIds: [seed.deals.won] }),
        expect.objectContaining({ check: "loss_deals", opportunityIds: [seed.deals.noShow] }),
        expect.objectContaining({ check: "loss_by_actor", key: harness.closerBId, byStatus: 0, byStage: 1 }),
      ]),
    );
  });

  it("pages over created-at windows and ends with the whole comparison", async () => {
    const { harness } = await seeded();
    const whole = await harness.t.query(internal.opportunities.stageParity.comparePipelineHealth, {
      tenantId: harness.tenantId,
      ...LOSS_RANGE,
    });
    const { last, calls } = await runToEnd(harness.t, internal.opportunities.stageParity.comparePipelineHealth, {
      tenantId: harness.tenantId,
      ...LOSS_RANGE,
      limits: { docBudget: 2, windowDays: 7, windowDocCap: 1 },
    });

    expect(calls).toBeGreaterThan(2);
    expect(last.differences).toEqual([]);
    expect(last.aging.windows).toBeGreaterThan(1);
    expect({ ...last.aging, windows: 0 }).toEqual({ ...whole.aging, windows: 0 });
    expect(last.velocity).toEqual(whole.velocity);
    expect(last.lossAttribution).toEqual(whole.lossAttribution);
  });
});

describe("compareTeamOutcomes", () => {
  it("finds no difference for any meeting, per closer", async () => {
    const { harness } = await seeded();
    const page = await harness.t.query(internal.opportunities.stageParity.compareTeamOutcomes, {
      tenantId: harness.tenantId,
      ...MEETING_RANGE,
    });

    expect(page.isDone).toBe(true);
    expect(page.ok).toBe(true);
    expect(page.differences).toEqual([]);
    expect(page.meetingsCompared).toBe(14);
    expect(page.closers).toEqual([
      { closerId: harness.closerAId, byStatus: closerAOutcomes, byStage: closerAOutcomes },
      { closerId: harness.closerBId, byStatus: closerBOutcomes, byStage: closerBOutcomes },
    ].sort((left, right) => left.closerId.localeCompare(right.closerId)));
  });

  it("reports each meeting whose outcome differs", async () => {
    const { harness, seed } = await seeded();
    await harness.t.run((ctx) =>
      forceOpportunityState(ctx, seed.deals.lostByCloser, { stage: "follow_up", outcome: "open" }),
    );

    const page = await harness.t.query(internal.opportunities.stageParity.compareTeamOutcomes, {
      tenantId: harness.tenantId,
      ...MEETING_RANGE,
    });

    expect(page.ok).toBe(false);
    expect(page.differenceCount).toBe(2);
    expect(page.differences).toEqual(
      expect.arrayContaining([
        {
          meetingId: seed.meetings.lostByCloser,
          opportunityId: seed.deals.lostByCloser,
          closerId: harness.closerAId,
          byStatus: "lost",
          byStage: "follow_up",
        },
        {
          meetingId: seed.meetings.lostByCloserEarly,
          opportunityId: seed.deals.lostByCloser,
          closerId: harness.closerAId,
          byStatus: "scheduled",
          byStage: "follow_up",
        },
      ]),
    );
  });

  it("pages over the meetings and ends with the whole comparison", async () => {
    const { harness } = await seeded();
    const whole = await harness.t.query(internal.opportunities.stageParity.compareTeamOutcomes, {
      tenantId: harness.tenantId,
      ...MEETING_RANGE,
    });
    const { last, calls } = await runToEnd(harness.t, internal.opportunities.stageParity.compareTeamOutcomes, {
      tenantId: harness.tenantId,
      ...MEETING_RANGE,
      pageSize: 4,
    });

    expect(calls).toBeGreaterThanOrEqual(4);
    expect(last.ok).toBe(true);
    expect(last.meetingsCompared).toBe(14);
    expect(last.closers).toEqual(whole.closers);
  });
});

describe("compareCloseRates", () => {
  it("finds the same won and lost for every closer", async () => {
    const { harness } = await seeded();
    const page = await harness.t.query(internal.opportunities.stageParity.compareCloseRates, {
      tenantId: harness.tenantId,
      ...MEETING_RANGE,
    });

    expect(page.isDone).toBe(true);
    expect(page.ok).toBe(true);
    expect(page.differences).toEqual([]);
    expect(
      page.closers.map(({ closerId, byStatus, byStage }) => ({
        closerId,
        byStatus: [byStatus.won, byStatus.lost, byStatus.closeRate],
        byStage: [byStage.won, byStage.lost, byStage.closeRate],
      })),
    ).toEqual([
      { closerId: harness.closerAId, byStatus: [1, 2, 1 / 3], byStage: [1, 2, 1 / 3] },
      { closerId: harness.closerBId, byStatus: [0, 2, 0], byStage: [0, 2, 0] },
    ]);
  });

  it("reports the deals behind a won or lost that differs", async () => {
    const { harness, seed } = await seeded();
    await harness.t.run((ctx) => forceOpportunityState(ctx, seed.deals.won, { stage: "closed", outcome: "lost" }));

    const page = await harness.t.query(internal.opportunities.stageParity.compareCloseRates, {
      tenantId: harness.tenantId,
      ...MEETING_RANGE,
    });

    expect(page.ok).toBe(false);
    expect(page.differences).toEqual(
      expect.arrayContaining([
        { closerId: harness.closerAId, check: "won", byStatus: 1, byStage: 0, opportunityIds: [seed.deals.won] },
        { closerId: harness.closerAId, check: "lost", byStatus: 2, byStage: 3, opportunityIds: [seed.deals.won] },
      ]),
    );
  });

  it("pages over the closers and ends with the whole comparison", async () => {
    const { harness } = await seeded();
    const whole = await harness.t.query(internal.opportunities.stageParity.compareCloseRates, {
      tenantId: harness.tenantId,
      ...MEETING_RANGE,
    });
    const { last, calls } = await runToEnd(harness.t, internal.opportunities.stageParity.compareCloseRates, {
      tenantId: harness.tenantId,
      ...MEETING_RANGE,
      docBudget: 1,
    });

    expect(calls).toBe(2);
    expect(last.ok).toBe(true);
    expect(last.closers).toEqual(whole.closers);
  });
});
