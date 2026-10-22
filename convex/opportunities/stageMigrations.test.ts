import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { DealSource, OpportunityStatus } from "./stages";
import { opportunityByStage } from "../reporting/aggregates";
import {
  countAtStage,
  harnessCloserId,
  insertDeal,
  missedMeetingLossReason,
  type DealFields,
} from "../../tests/dealStageFixtures";
import {
  enrollmentHarness,
  type EnrollmentHarness,
} from "../../tests/enrollmentFixtures";
import { forceOpportunityState } from "../../tests/opportunityFixtures";
import { insertDealTask } from "../../tests/dealStateFixtures";

// assertDealStages (docs/plans/phase-5-deal-status.md §10.2) and
// backfillOpportunityByStage, on a deal at every stage, written as the stage
// machine leaves it.

afterEach(() => vi.useRealTimers());

type Seeded = Record<string, Id<"opportunities">>;

async function deal(
  harness: EnrollmentHarness,
  status: OpportunityStatus,
  source: DealSource,
  fields: DealFields = {},
) {
  return await harness.t.run(async (ctx) => {
    const reason = missedMeetingLossReason(status);
    return await insertDeal(ctx, {
      tenantId: harness.tenantId,
      status,
      source,
      fields: {
        assignedCloserId: source === "slack_qualified" && status === "qualified_pending"
          ? undefined
          : await harnessCloserId(ctx),
        ...(reason ? { lostReason: reason, lostAt: 40_000 } : {}),
        ...fields,
      },
    });
  });
}

async function seeded() {
  const harness = await enrollmentHarness();
  const ids: Seeded = {
    qualified: await deal(harness, "qualified_pending", "slack_qualified"),
    booked: await deal(harness, "scheduled", "calendly"),
    sideDeal: await deal(harness, "scheduled", "side_deal"),
    followUp: await deal(harness, "follow_up_scheduled", "calendly"),
    linkSent: await deal(harness, "reschedule_link_sent", "calendly"),
    won: await deal(harness, "payment_received", "side_deal"),
    stale: await deal(harness, "lost", "slack_qualified", { lostReason: "stale", lostAt: 30_000 }),
    closerLost: await deal(harness, "lost", "calendly", {
      lostReason: "budget",
      lostAt: 31_000,
      lostByUserId: harness.closerId,
    }),
    canceled: await deal(harness, "canceled", "calendly"),
    noShow: await deal(harness, "no_show", "calendly"),
  };
  // The reschedule link that reopened the deal (§4.5), and the follow-up
  // deal's own link, which isn't one.
  await harness.t.run(async (ctx) => {
    await insertDealTask(ctx, ids.linkSent);
    await insertDealTask(ctx, ids.followUp, { reason: "closer_initiated" });
  });
  return { harness, ids };
}

describe("assertDealStages", () => {
  it("passes on a deal at every stage", async () => {
    const { harness } = await seeded();
    expect((await harness.run("assertDealStages"))?.error).toBeUndefined();
  });

  it("accepts a side deal at Booked: the stage machine sets the pair", async () => {
    const { harness, ids } = await seeded();
    await harness.t.run((ctx) => forceOpportunityState(ctx, ids.sideDeal, { stage: "booked" }));

    expect((await harness.run("assertDealStages"))?.error).toBeUndefined();
  });

  it("names a deal whose pair the stage doesn't allow", async () => {
    const { harness, ids } = await seeded();
    await harness.t.run((ctx) => forceOpportunityState(ctx, ids.won, { outcome: "open" }));

    const error = (await harness.run("assertDealStages"))?.error;
    expect(error).toContain(ids.won);
    expect(error).toContain('has stage "closed", which doesn\'t allow outcome "open"');
  });

  it("names a missed meeting's loss with no time", async () => {
    const { harness, ids } = await seeded();
    await harness.t.run((ctx) => forceOpportunityState(ctx, ids.canceled, { lostAt: undefined }));

    const error = (await harness.run("assertDealStages"))?.error;
    expect(error).toContain(ids.canceled);
    expect(error).toContain("is closed by a missed meeting (canceled) and has no lostAt");
  });

  it("accepts a person's loss whose free text matches a system code", async () => {
    const { harness, ids } = await seeded();
    await harness.t.run((ctx) => forceOpportunityState(ctx, ids.noShow, { lostByUserId: harness.closerId }));
    await harness.t.run((ctx) => forceOpportunityState(ctx, ids.stale, { lostByUserId: harness.closerId }));

    expect((await harness.run("assertDealStages"))?.error).toBeUndefined();
  });

  it("names a Follow-up deal with two pending reschedule links", async () => {
    const { harness, ids } = await seeded();
    await harness.t.run((ctx) => insertDealTask(ctx, ids.linkSent, { createdAt: 2 }));

    const error = (await harness.run("assertDealStages"))?.error;
    expect(error).toContain(ids.linkSent);
    expect(error).toContain("is at follow_up and has 2 pending reschedule links");
  });

  it("names a deal off Follow-up that still has a pending reschedule link", async () => {
    const { harness, ids } = await seeded();
    await harness.t.run((ctx) => insertDealTask(ctx, ids.noShow));

    const error = (await harness.run("assertDealStages"))?.error;
    expect(error).toContain(ids.noShow);
    expect(error).toContain("is at closed and has 1 pending reschedule links");
  });
});

describe("backfillOpportunityByStage", () => {
  it("enters every deal it doesn't hold, once, and a rerun changes nothing", async () => {
    const { harness } = await seeded();
    const total = () => harness.t.run((ctx) => opportunityByStage.count(ctx, { namespace: harness.tenantId }));
    expect(await total()).toBe(10);
    await harness.t.run((ctx) => opportunityByStage.clear(ctx, { namespace: harness.tenantId }));
    expect(await total()).toBe(0);

    expect((await harness.run("backfillOpportunityByStage"))?.error).toBeUndefined();
    expect(await total()).toBe(10);
    expect((await harness.rerun("backfillOpportunityByStage"))?.error).toBeUndefined();
    expect(await total()).toBe(10);
    expect(await harness.t.run((ctx) => countAtStage(ctx, harness.tenantId, "closed", "lost"))).toBe(4);
  });
});
