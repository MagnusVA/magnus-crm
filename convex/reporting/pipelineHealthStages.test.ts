import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import {
  LOSS_RANGE,
  MEETING_RANGE,
  closerAOutcomes,
  closerBOutcomes,
  seededMixedPipeline,
} from "../../tests/reportStageFixtures";

// Pipeline Health and the team report read the deal's stage and outcome
// (docs/plans/phase-5-deal-status.md §6.6, §7), on the mixed pipeline: a
// deal at every old status, the side deal, and losses by a person and by the
// system.

afterEach(() => vi.useRealTimers());

describe("Pipeline Health by stage", () => {
  it("shows the six positions, the canceled and no-show deals under Lost", async () => {
    const { harness } = await seededMixedPipeline();

    const { distribution } = await harness.admin.query(
      api.reporting.pipelineHealth.getPipelineDistribution,
      {},
    );

    expect(distribution).toEqual([
      { position: "qualified", count: 1 },
      { position: "booked", count: 2 },
      { position: "call_held", count: 1 },
      { position: "follow_up", count: 2 },
      { position: "won", count: 2 },
      { position: "lost", count: 7 },
    ]);
  });

  it("ages the open deals by stage, the side deal at Call held, and lists the stale ones by position", async () => {
    const { harness, seed } = await seededMixedPipeline();

    const aging = await harness.admin.query(api.reporting.pipelineHealth.getPipelineAging, {});

    expect(aging.agingByStage).toEqual({
      qualified: { count: 1, averageAgeDays: 5, oldestAgeDays: 5 },
      booked: { count: 2, averageAgeDays: 43 / 2, oldestAgeDays: 40 },
      call_held: { count: 1, averageAgeDays: 10, oldestAgeDays: 10 },
      follow_up: { count: 2, averageAgeDays: 55 / 2, oldestAgeDays: 30 },
    });
    expect(aging.staleCount).toBe(4);
    expect(aging.staleOpps.map((row) => [row.opportunityId, row.position])).toEqual([
      [seed.deals.bookedStale, "booked"],
      [seed.deals.linkSent, "follow_up"],
      [seed.deals.sideDeal, "call_held"],
      [seed.deals.qualified, "qualified"],
    ]);
    expect(aging.velocityDays).toBe(5);
    expect([aging.isAgingTruncated, aging.isVelocityTruncated]).toEqual([false, false]);
  });

  it("attributes the losses a person recorded in the range, leaving out the system's", async () => {
    const { harness } = await seededMixedPipeline();

    const loss = await harness.admin.query(
      api.reporting.pipelineHealth.getPipelineBacklogAndLoss,
      LOSS_RANGE,
    );

    expect(loss.lossAttribution).toMatchObject({ admin: 1, closer: 1, unknown: 1 });
    expect(loss.lossAttribution.byActor.map((actor) => [actor.userId, actor.count])).toEqual(
      expect.arrayContaining([
        [harness.adminId, 1],
        [harness.closerAId, 1],
      ]),
    );
    expect(loss.isLossAttributionTruncated).toBe(false);
  });
});

describe("the team report by stage", () => {
  it("gives every closer their outcome mix", async () => {
    const { harness } = await seededMixedPipeline();

    const team = await harness.admin.query(api.reporting.teamOutcomes.getTeamOutcomeMix, MEETING_RANGE);

    expect(
      Object.fromEntries(team.closerOutcomes.map(({ closerId, outcomes }) => [closerId, outcomes])),
    ).toEqual({
      [harness.closerAId]: closerAOutcomes,
      [harness.closerBId]: closerBOutcomes,
    });
    expect(team.derived.lostDeals).toBe(closerAOutcomes.lost + closerBOutcomes.lost);
  });
});
