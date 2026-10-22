import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  countCloserPipelineByStage,
  countCloserPipelineByStatus,
  countStripByStage,
  countStripByStatus,
  readCloserMeetingDeals,
} from "../closer/dashboard";
import {
  countLossesByActor,
  readLossesByStage,
  readLossesByStatus,
  readPipelineDistributionByStage,
  readPipelineDistributionByStatus,
  readPipelineVelocityByStage,
  readPipelineVelocityByStatus,
  scanPipelineAgingByStage,
  scanPipelineAgingByStatus,
} from "./pipelineHealth";
import {
  meetingOutcomesByStage,
  meetingOutcomesByStatus,
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
  noStatuses,
  seededParityHarness,
} from "../../tests/stageParityFixtures";

// Each report number from the stage beside today's from the status
// (docs/plans/phase-5-deal-status.md §6.2, §6.6, §7), on a small tenant with
// a deal at every status. The screens still read the status ways.

afterEach(() => vi.useRealTimers());

const seeded = seededParityHarness;

describe("the stage way of each report number", () => {
  it("counts the distribution in six positions, the statuses merged", async () => {
    const { harness } = await seeded();
    const { byStatus, byStage } = await harness.t.run(async (ctx) => ({
      byStatus: await readPipelineDistributionByStatus(ctx, harness.tenantId),
      byStage: await readPipelineDistributionByStage(ctx, harness.tenantId),
    }));

    expect(Object.fromEntries(byStatus.map(({ status, count }) => [status, count]))).toEqual({
      ...noStatuses,
      qualified_pending: 1,
      scheduled: 3,
      follow_up_scheduled: 1,
      reschedule_link_sent: 1,
      payment_received: 2,
      lost: 5,
      canceled: 1,
      no_show: 1,
    });
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
    const { byStatus, byStage } = await harness.t.run(async (ctx) => ({
      byStatus: await scanPipelineAgingByStatus(ctx, harness.tenantId, NOW),
      byStage: await scanPipelineAgingByStage(ctx, harness.tenantId, NOW),
    }));

    expect(byStatus.groups).toEqual({
      qualified_pending: { count: 1, totalAgeDays: 5, oldestAgeDays: 5 },
      scheduled: { count: 3, totalAgeDays: 53, oldestAgeDays: 40 },
      follow_up_scheduled: { count: 1, totalAgeDays: 30, oldestAgeDays: 30 },
      reschedule_link_sent: { count: 1, totalAgeDays: 25, oldestAgeDays: 25 },
    });
    expect(byStage.groups).toEqual({
      qualified: { count: 1, totalAgeDays: 5, oldestAgeDays: 5 },
      booked: { count: 2, totalAgeDays: 43, oldestAgeDays: 40 },
      call_held: { count: 1, totalAgeDays: 10, oldestAgeDays: 10 },
      follow_up: { count: 2, totalAgeDays: 55, oldestAgeDays: 30 },
    });
    expect([byStatus.staleCount, byStage.staleCount]).toEqual([4, 4]);
    const staleIds = (scan: typeof byStatus | typeof byStage) =>
      scan.staleCandidates.map(({ opportunity }) => opportunity._id).sort();
    expect(staleIds(byStage)).toEqual(staleIds(byStatus));
    expect(staleIds(byStage)).toEqual(
      [seed.deals.qualified, seed.deals.bookedStale, seed.deals.sideDeal, seed.deals.linkSent].sort(),
    );
    expect([byStatus.capped, byStage.capped]).toEqual([false, false]);
  });

  it("measures velocity over the same won deals", async () => {
    const { harness, seed } = await seeded();
    const { byStatus, byStage } = await harness.t.run(async (ctx) => ({
      byStatus: await readPipelineVelocityByStatus(ctx, harness.tenantId, NOW),
      byStage: await readPipelineVelocityByStage(ctx, harness.tenantId, NOW),
    }));

    expect(byStage).toEqual(byStatus);
    expect(byStage).toEqual({ velocityDays: 5, opportunityIds: [seed.deals.won], truncated: false });
  });

  it("attributes the same losses, leaving out every loss the system wrote", async () => {
    const { harness, seed } = await seeded();
    const { byStatus, byStage } = await harness.t.run(async (ctx) => ({
      byStatus: await readLossesByStatus(ctx, harness.tenantId, LOSS_RANGE.startDate, LOSS_RANGE.endDate),
      byStage: await readLossesByStage(ctx, harness.tenantId, LOSS_RANGE.startDate, LOSS_RANGE.endDate),
    }));

    const ids = (losses: typeof byStatus) => losses.losses.map((deal) => deal._id).sort();
    expect(ids(byStage)).toEqual(ids(byStatus));
    expect(ids(byStage)).toEqual(
      [seed.deals.lostByCloser, seed.deals.lostByAdmin, seed.deals.lostUnknown].sort(),
    );
    // The stage way reads from the range's start by activity, as the status
    // way does: it never reads the stale expiry, which keeps its earlier
    // activity, and passes over the canceled and no-show losses and a loss
    // from before the range that had activity since.
    expect([byStatus.truncated, byStage.truncated]).toEqual([false, false]);
    expect(byStage.scanned).toBe(6);
    const scannedStale = await harness.t.run(async (ctx) => {
      const deal = await ctx.db.get("opportunities", seed.deals.stale);
      return deal?.lostAt !== undefined && deal.lostAt >= LOSS_RANGE.startDate;
    });
    // The stale loss is in the range by lostAt, yet not among the six read.
    expect(scannedStale).toBe(true);
    const counts = countLossesByActor(byStage.losses);
    expect(counts).toEqual(countLossesByActor(byStatus.losses));
    expect(counts.unknownLossCount).toBe(1);
    expect(Object.fromEntries(counts.lossCountsByActor)).toEqual({
      [harness.closerAId]: 1,
      [harness.adminId]: 1,
    });
  });

  it("derives the same outcome for every meeting in the team report", async () => {
    const { harness } = await seeded();
    const { byStatus, byStage } = await harness.t.run(async (ctx) => {
      const inputs = await readTeamOutcomeInputs(ctx, harness.tenantId, MEETING_RANGE.startDate, MEETING_RANGE.endDate);
      return {
        byStatus: meetingOutcomesByStatus(inputs),
        byStage: await meetingOutcomesByStage(ctx, inputs),
      };
    });

    const outcomes = (list: typeof byStatus) => list.map(({ meeting, outcome }) => [meeting._id, outcome]);
    expect(byStage).toHaveLength(14);
    expect(outcomes(byStage)).toEqual(outcomes(byStatus));
    expect(Object.fromEntries(tallyOutcomesByCloser(byStage))).toEqual({
      [harness.closerAId]: closerAOutcomes,
      [harness.closerBId]: closerBOutcomes,
    });
  });

  it("counts each closer's pipeline tabs in six positions, the statuses merged", async () => {
    const { harness } = await seeded();
    const counts = await harness.t.run(async (ctx) => ({
      aByStatus: await countCloserPipelineByStatus(ctx, harness.tenantId, harness.closerAId),
      aByStage: await countCloserPipelineByStage(ctx, harness.tenantId, harness.closerAId),
      bByStatus: await countCloserPipelineByStatus(ctx, harness.tenantId, harness.closerBId),
      bByStage: await countCloserPipelineByStage(ctx, harness.tenantId, harness.closerBId),
    }));

    expect(counts.aByStatus).toEqual({
      counts: { ...noStatuses, scheduled: 2, follow_up_scheduled: 1, payment_received: 1, lost: 2, canceled: 1 },
      total: 7,
    });
    expect(counts.aByStage).toEqual({
      counts: { ...noPositions, booked: 1, call_held: 1, follow_up: 1, won: 1, lost: 3 },
      total: 7,
    });
    expect(counts.bByStatus).toEqual({
      counts: { ...noStatuses, scheduled: 1, reschedule_link_sent: 1, payment_received: 1, lost: 2, no_show: 1 },
      total: 6,
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
        const deals = await readCloserMeetingDeals(
          ctx,
          harness.tenantId,
          closerId,
          MEETING_RANGE.startDate,
          MEETING_RANGE.endDate,
        );
        return { byStatus: countStripByStatus(deals), byStage: countStripByStage(deals) };
      };
      return { a: await strip(harness.closerAId), b: await strip(harness.closerBId) };
    });

    expect(strips.a.byStatus.counts).toEqual({
      ...noStatuses,
      scheduled: 1,
      follow_up_scheduled: 1,
      payment_received: 1,
      lost: 2,
      canceled: 1,
    });
    expect(strips.a.byStage).toEqual({
      counts: { ...noPositions, booked: 1, follow_up: 1, won: 1, lost: 3 },
      total: 6,
      won: 1,
      lost: 2,
    });
    expect([strips.a.byStatus.counts.payment_received, strips.a.byStatus.counts.lost]).toEqual([1, 2]);
    expect(strips.b.byStage).toEqual({
      counts: { ...noPositions, booked: 1, follow_up: 1, lost: 3 },
      total: 5,
      won: 0,
      lost: 2,
    });
    expect([strips.b.byStatus.counts.payment_received, strips.b.byStatus.counts.lost]).toEqual([0, 2]);
  });

  it("leaves every screen on the status way", async () => {
    const { harness, seed } = await seeded();

    const aging = await harness.admin.query(api.reporting.pipelineHealth.getPipelineAging, {});
    expect(Object.keys(aging.agingByStatus).sort()).toEqual(
      ["qualified_pending", "scheduled", "follow_up_scheduled", "reschedule_link_sent"].sort(),
    );
    expect(aging.agingByStatus.scheduled).toEqual({ count: 3, averageAgeDays: 53 / 3, oldestAgeDays: 40 });
    expect(aging.staleCount).toBe(4);
    expect(aging.staleOpps.map((row) => row.opportunityId)).toEqual([
      seed.deals.bookedStale,
      seed.deals.linkSent,
      seed.deals.sideDeal,
      seed.deals.qualified,
    ]);
    expect(aging.velocityDays).toBe(5);

    const distribution = await harness.admin.query(api.reporting.pipelineHealth.getPipelineDistribution, {});
    expect(distribution.distribution.map(({ status }) => status)).toContain("canceled");

    const loss = await harness.admin.query(api.reporting.pipelineHealth.getPipelineBacklogAndLoss, LOSS_RANGE);
    expect(loss.lossAttribution).toMatchObject({ admin: 1, closer: 1, unknown: 1 });

    const allTime = await harness.closer.query(api.closer.dashboard.getPipelineSummary, {});
    expect(allTime.total).toBe(7);
    expect(allTime.counts.canceled).toBe(1);
    const filtered = await harness.closer.query(api.closer.dashboard.getPipelineSummary, MEETING_RANGE);
    expect([filtered.counts.payment_received, filtered.counts.lost, filtered.total]).toEqual([1, 2, 6]);

    const team = await harness.admin.query(api.reporting.teamOutcomes.getTeamOutcomeMix, MEETING_RANGE);
    expect(Object.fromEntries(team.closerOutcomes.map(({ closerId, outcomes }) => [closerId, outcomes]))).toEqual({
      [harness.closerAId]: closerAOutcomes,
      [harness.closerBId]: closerBOutcomes,
    });
  });
});
