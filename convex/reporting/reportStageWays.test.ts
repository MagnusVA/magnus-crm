import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  countCloserPipelineByStage,
  countStripByStage,
  readCloserMeetingDeals,
} from "../closer/dashboard";
import {
  countLossesByActor,
  readLossesByStage,
  readPipelineDistributionByStage,
  readPipelineVelocityByStage,
  scanPipelineAgingByStage,
} from "./pipelineHealth";
import {
  meetingOutcomesByStage,
  readTeamOutcomeInputs,
  tallyOutcomesByCloser,
} from "./teamOutcomes";
import {
  LOSS_RANGE,
  MEETING_RANGE,
  NOW,
  closerAOutcomes,
  closerBOutcomes,
  noPositions,
  seededMixedPipeline,
} from "../../tests/reportStageFixtures";

// Each report number from the stage (docs/plans/phase-5-deal-status.md §6.2,
// §6.6, §7), on a small tenant with a deal at every old status, written as
// its stage.

afterEach(() => vi.useRealTimers());

const seeded = seededMixedPipeline;

describe("each report number by stage", () => {
  it("counts the distribution in six positions", async () => {
    const { harness } = await seeded();
    const byStage = await harness.t.run((ctx) => readPipelineDistributionByStage(ctx, harness.tenantId));

    // Scheduled splits into Booked and the side deal's Call held; Lost takes
    // the canceled and no-show deals (§7).
    expect(Object.fromEntries(byStage.map(({ position, count }) => [position, count]))).toEqual({
      qualified: 1,
      booked: 2,
      call_held: 1,
      follow_up: 2,
      won: 2,
      lost: 7,
    });
  });

  it("ages the same open deals, with Scheduled split into Booked and Call held", async () => {
    const { harness, seed } = await seeded();
    const byStage = await harness.t.run((ctx) => scanPipelineAgingByStage(ctx, harness.tenantId, NOW));

    expect(byStage.groups).toEqual({
      qualified: { count: 1, totalAgeDays: 5, oldestAgeDays: 5 },
      booked: { count: 2, totalAgeDays: 43, oldestAgeDays: 40 },
      call_held: { count: 1, totalAgeDays: 10, oldestAgeDays: 10 },
      follow_up: { count: 2, totalAgeDays: 55, oldestAgeDays: 30 },
    });
    expect(byStage.staleCount).toBe(4);
    const staleIds = byStage.staleCandidates.map(({ opportunity }) => opportunity._id).sort();
    expect(staleIds).toEqual(
      [seed.deals.qualified, seed.deals.bookedStale, seed.deals.sideDeal, seed.deals.linkSent].sort(),
    );
    expect(byStage.capped).toBe(false);
  });

  it("measures velocity over the same won deals", async () => {
    const { harness, seed } = await seeded();
    const byStage = await harness.t.run((ctx) => readPipelineVelocityByStage(ctx, harness.tenantId, NOW));

    expect(byStage).toEqual({ velocityDays: 5, opportunityIds: [seed.deals.won], truncated: false });
  });

  it("attributes the same losses, leaving out every loss the system wrote", async () => {
    const { harness, seed } = await seeded();
    const byStage = await harness.t.run((ctx) =>
      readLossesByStage(ctx, harness.tenantId, LOSS_RANGE.startDate, LOSS_RANGE.endDate),
    );

    expect(byStage.losses.map((deal) => deal._id).sort()).toEqual(
      [seed.deals.lostByCloser, seed.deals.lostByAdmin, seed.deals.lostUnknown].sort(),
    );
    // It reads from the range's start by activity: it never reads the stale
    // expiry, which keeps its earlier activity, and passes over the canceled
    // and no-show losses and a loss from before the range that had activity
    // since.
    expect(byStage.truncated).toBe(false);
    expect(byStage.scanned).toBe(6);
    const scannedStale = await harness.t.run(async (ctx) => {
      const deal = await ctx.db.get("opportunities", seed.deals.stale);
      return deal?.lostAt !== undefined && deal.lostAt >= LOSS_RANGE.startDate;
    });
    // The stale loss is in the range by lostAt, yet not among the six read.
    expect(scannedStale).toBe(true);
    const counts = countLossesByActor(byStage.losses);
    expect(counts.unknownLossCount).toBe(1);
    expect(Object.fromEntries(counts.lossCountsByActor)).toEqual({
      [harness.closerAId]: 1,
      [harness.adminId]: 1,
    });
  });

  it("derives the same outcome for every meeting in the team report", async () => {
    const { harness } = await seeded();
    const byStage = await harness.t.run(async (ctx) => {
      const inputs = await readTeamOutcomeInputs(ctx, harness.tenantId, MEETING_RANGE.startDate, MEETING_RANGE.endDate);
      return await meetingOutcomesByStage(ctx, inputs);
    });

    expect(byStage).toHaveLength(14);
    expect(Object.fromEntries(tallyOutcomesByCloser(byStage))).toEqual({
      [harness.closerAId]: closerAOutcomes,
      [harness.closerBId]: closerBOutcomes,
    });
  });

  it("counts each closer's pipeline tabs in six positions", async () => {
    const { harness } = await seeded();
    const counts = await harness.t.run(async (ctx) => ({
      aByStage: await countCloserPipelineByStage(ctx, harness.tenantId, harness.closerAId),
      bByStage: await countCloserPipelineByStage(ctx, harness.tenantId, harness.closerBId),
    }));

    expect(counts.aByStage).toEqual({
      counts: { ...noPositions, booked: 1, call_held: 1, follow_up: 1, won: 1, lost: 3 },
      total: 7,
    });
    expect(counts.bByStage).toEqual({
      counts: { ...noPositions, booked: 1, follow_up: 1, won: 1, lost: 3 },
      total: 6,
    });
  });

  it("gives the strip the same won and lost, leaving the system's losses out of the close rate", async () => {
    const { harness } = await seeded();
    const strips = await harness.t.run(async (ctx) => {
      const strip = async (closerId: Id<"users">) => {
        const { deals } = await readCloserMeetingDeals(
          ctx,
          harness.tenantId,
          closerId,
          MEETING_RANGE.startDate,
          MEETING_RANGE.endDate,
        );
        return { byStage: countStripByStage(deals) };
      };
      return { a: await strip(harness.closerAId), b: await strip(harness.closerBId) };
    });

    expect(strips.a.byStage).toEqual({
      counts: { ...noPositions, booked: 1, follow_up: 1, won: 1, lost: 3 },
      total: 6,
      won: 1,
      lost: 2,
    });
    expect(strips.b.byStage).toEqual({
      counts: { ...noPositions, booked: 1, follow_up: 1, lost: 3 },
      total: 5,
      won: 0,
      lost: 2,
    });
  });

  it("shows the closer's tabs and strip the stage way", async () => {
    const { harness } = await seeded();

    const allTime = await harness.closer.query(api.closer.dashboard.getPipelineSummary, {});
    expect(allTime).toMatchObject({
      counts: { ...noPositions, booked: 1, call_held: 1, follow_up: 1, won: 1, lost: 3 },
      total: 7,
    });
    const filtered = await harness.closer.query(api.closer.dashboard.getPipelineSummary, MEETING_RANGE);
    // Won 1, and the 2 deals a person lost.
    expect([filtered.decided, filtered.total]).toEqual([{ won: 1, lost: 2 }, 6]);
  });
});
