import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { OpportunityStatus } from "../lib/statusTransitions";
import {
  countAtStage,
  harnessCloserId,
  insertDeal,
  insertLatestMeeting,
  type DealFields,
} from "../../tests/dealStageFixtures";
import {
  enrollmentHarness,
  type EnrollmentHarness,
} from "../../tests/enrollmentFixtures";
import { forceOpportunityState } from "../../tests/opportunityFixtures";
import type { DealSource } from "./stages";

// The deal stage backfill and its checks (docs/plans/phase-5-deal-status.md
// §10.1, §10.2), on deals as production holds them before the backfill.

afterEach(() => vi.useRealTimers());

const UPDATED = 50_000;
const ACTIVITY = 60_000;
const DEAL_CANCELED = 41_000;
const MEETING_CANCELED = 42_000;
const DEAL_NO_SHOW = 43_000;
const MEETING_NO_SHOW = 44_000;

type Seeded = Record<string, Id<"opportunities">>;

/** A deal from before the widen: no stage, and only in opportunityByStatus. */
async function oldDeal(
  harness: EnrollmentHarness,
  status: OpportunityStatus,
  source: DealSource,
  fields: DealFields = {},
  meeting?: Partial<Doc<"meetings">> & Pick<Doc<"meetings">, "status">,
) {
  return await harness.t.run(async (ctx) => {
    const opportunityId = await insertDeal(ctx, {
      tenantId: harness.tenantId,
      status,
      source,
      written: false,
      fields: {
        assignedCloserId: source === "slack_qualified" && status === "qualified_pending"
          ? undefined
          : await harnessCloserId(ctx),
        updatedAt: UPDATED,
        latestActivityAt: ACTIVITY,
        ...fields,
      },
    });
    if (meeting) {
      await insertLatestMeeting(ctx, opportunityId, meeting);
    }
    return opportunityId;
  });
}

async function seed(harness: EnrollmentHarness): Promise<Seeded> {
  const closerId = harness.closerId;
  return {
    qualified: await oldDeal(harness, "qualified_pending", "slack_qualified"),
    booked: await oldDeal(harness, "scheduled", "calendly"),
    sideDeal: await oldDeal(harness, "scheduled", "side_deal"),
    followUp: await oldDeal(harness, "follow_up_scheduled", "calendly"),
    linkSent: await oldDeal(harness, "reschedule_link_sent", "calendly"),
    won: await oldDeal(harness, "payment_received", "side_deal"),
    stale: await oldDeal(harness, "lost", "slack_qualified", { lostReason: "stale", lostAt: 30_000 }),
    closerLost: await oldDeal(harness, "lost", "calendly", {
      lostReason: "budget",
      lostAt: 31_000,
      lostByUserId: closerId,
    }),
    canceledOnDeal: await oldDeal(harness, "canceled", "calendly", { canceledAt: DEAL_CANCELED }, {
      status: "canceled",
      canceledAt: MEETING_CANCELED,
    }),
    canceledOnMeeting: await oldDeal(harness, "canceled", "slack_qualified", {}, {
      status: "canceled",
      canceledAt: MEETING_CANCELED,
    }),
    canceledHeld: await oldDeal(harness, "canceled", "calendly", {}, { status: "completed" }),
    noShowOnDeal: await oldDeal(harness, "no_show", "calendly", { noShowAt: DEAL_NO_SHOW }),
    noShowOnMeeting: await oldDeal(harness, "no_show", "calendly", {}, {
      status: "no_show",
      noShowMarkedAt: MEETING_NO_SHOW,
    }),
    noShowBare: await oldDeal(harness, "no_show", "slack_qualified"),
  };
}

async function deals(harness: EnrollmentHarness, ids: Seeded) {
  return await harness.t.run(async (ctx) => {
    const entries = await Promise.all(
      Object.entries(ids).map(async ([name, id]) => [name, (await ctx.db.get("opportunities", id))!] as const),
    );
    return Object.fromEntries(entries) as Record<string, Doc<"opportunities">>;
  });
}

async function backfilled() {
  const harness = await enrollmentHarness();
  const ids = await seed(harness);
  expect((await harness.run("backfillDealStages"))?.error).toBeUndefined();
  return { harness, ids };
}

describe("backfillDealStages", () => {
  it("sets every deal's stage and outcome from its status and source", async () => {
    const { harness, ids } = await backfilled();

    const rows = await deals(harness, ids);
    expect(
      Object.fromEntries(Object.entries(rows).map(([name, deal]) => [name, `${deal.stage}/${deal.outcome}`])),
    ).toEqual({
      qualified: "qualified/open",
      booked: "booked/open",
      sideDeal: "call_held/open",
      followUp: "follow_up/open",
      linkSent: "follow_up/open",
      won: "closed/won",
      stale: "closed/lost",
      closerLost: "closed/lost",
      canceledOnDeal: "closed/lost",
      canceledOnMeeting: "closed/lost",
      canceledHeld: "closed/lost",
      noShowOnDeal: "closed/lost",
      noShowOnMeeting: "closed/lost",
      noShowBare: "closed/lost",
    });
  });

  it("closes a missed meeting's deal at the deal's time, else its meeting's, else its last update", async () => {
    const { harness, ids } = await backfilled();

    const rows = await deals(harness, ids);
    const loss = (deal: Doc<"opportunities">) => [deal.lostReason, deal.lostAt, deal.lostByUserId];
    expect(loss(rows.canceledOnDeal)).toEqual(["canceled", DEAL_CANCELED, undefined]);
    expect(loss(rows.canceledOnMeeting)).toEqual(["canceled", MEETING_CANCELED, undefined]);
    expect(loss(rows.canceledHeld)).toEqual(["canceled", UPDATED, undefined]);
    expect(loss(rows.noShowOnDeal)).toEqual(["no_show", DEAL_NO_SHOW, undefined]);
    expect(loss(rows.noShowOnMeeting)).toEqual(["no_show", MEETING_NO_SHOW, undefined]);
    expect(loss(rows.noShowBare)).toEqual(["no_show", UPDATED, undefined]);
  });

  it("keeps the other deals' loss fields, and every deal's update and activity times", async () => {
    const { harness, ids } = await backfilled();

    const rows = await deals(harness, ids);
    expect([rows.stale.lostReason, rows.stale.lostAt, rows.stale.lostByUserId]).toEqual(["stale", 30_000, undefined]);
    expect([rows.closerLost.lostReason, rows.closerLost.lostByUserId]).toEqual(["budget", harness.closerId]);
    for (const name of ["qualified", "booked", "followUp", "won"]) {
      expect(rows[name].lostReason).toBeUndefined();
    }
    for (const deal of Object.values(rows)) {
      expect([deal.updatedAt, deal.latestActivityAt]).toEqual([UPDATED, ACTIVITY]);
    }
  });

  it("changes nothing on a rerun", async () => {
    const { harness, ids } = await backfilled();
    const first = await deals(harness, ids);

    expect((await harness.rerun("backfillDealStages"))?.error).toBeUndefined();

    expect(await deals(harness, ids)).toEqual(first);
  });

  it("leaves a missed meeting's deal that already has its loss alone", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await oldDeal(harness, "canceled", "calendly", {
      canceledAt: DEAL_CANCELED,
      lostReason: "canceled",
      lostAt: 45_000,
    });

    await harness.run("backfillDealStages");

    const [deal] = Object.values(await deals(harness, { opportunityId }));
    expect([deal.stage, deal.outcome, deal.lostReason, deal.lostAt]).toEqual(["closed", "lost", "canceled", 45_000]);
  });

  it("fills the time of a missed meeting's loss that has its reason but no time", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await oldDeal(harness, "canceled", "calendly", {
      canceledAt: DEAL_CANCELED,
      lostReason: "canceled",
    });

    await harness.run("backfillDealStages");

    const [deal] = Object.values(await deals(harness, { opportunityId }));
    expect([deal.lostReason, deal.lostAt]).toEqual(["canceled", DEAL_CANCELED]);
  });

  it("keeps a missed meeting's deal's other reason for the assert to report", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await oldDeal(harness, "canceled", "calendly", {
      canceledAt: DEAL_CANCELED,
      lostReason: "no_show",
    });

    await harness.run("backfillDealStages");

    const [deal] = Object.values(await deals(harness, { opportunityId }));
    expect([deal.lostReason, deal.lostAt]).toEqual(["no_show", undefined]);
  });
});

describe("assertDealStages", () => {
  it("fails before the backfill, naming a deal with no stage", async () => {
    const harness = await enrollmentHarness();
    const ids = await seed(harness);

    const error = (await harness.run("assertDealStages"))?.error;
    expect(error).toContain("has no stage or outcome");
    expect(Object.values(ids).some((id) => error?.includes(id))).toBe(true);
  });

  it("passes after the backfill", async () => {
    const { harness } = await backfilled();
    expect((await harness.run("assertDealStages"))?.error).toBeUndefined();
  });

  it("names a deal whose stage isn't its status's", async () => {
    const { harness, ids } = await backfilled();
    await harness.t.run((ctx) => forceOpportunityState(ctx, ids.sideDeal, { stage: "booked" }));

    const error = (await harness.run("assertDealStages"))?.error;
    expect(error).toContain(ids.sideDeal);
    expect(error).toContain("booked/open, expected call_held/open for scheduled");
  });

  it("names a deal whose pair the stage doesn't allow", async () => {
    const { harness, ids } = await backfilled();
    await harness.t.run((ctx) => forceOpportunityState(ctx, ids.won, { outcome: "open" }));

    const error = (await harness.run("assertDealStages"))?.error;
    expect(error).toContain(ids.won);
    expect(error).toContain('has stage "closed", which doesn\'t allow outcome "open"');
  });

  it.each([
    ["no reason", { lostReason: undefined }, "has no reason, expected canceled"],
    ["the other code", { lostReason: "no_show" }, "has the reason no_show, expected canceled"],
    ["a reason a person typed", { lostReason: "they moved" }, "has a free-text reason, expected canceled"],
  ])("names a canceled deal with %s", async (_label, patch, message) => {
    const { harness, ids } = await backfilled();
    await harness.t.run((ctx) => forceOpportunityState(ctx, ids.canceledOnDeal, patch));

    const error = (await harness.run("assertDealStages"))?.error;
    expect(error).toContain(ids.canceledOnDeal);
    expect(error).toContain(message);
    expect(error).not.toContain("they moved");
  });

  it("names a canceled deal with its reason but no time", async () => {
    const { harness, ids } = await backfilled();
    await harness.t.run((ctx) => forceOpportunityState(ctx, ids.canceledOnDeal, { lostAt: undefined }));

    const error = (await harness.run("assertDealStages"))?.error;
    expect(error).toContain(ids.canceledOnDeal);
    expect(error).toContain("has no lostAt");
  });

  it.each(["noShowOnDeal", "stale"])("names a %s deal whose system loss has a person", async (name) => {
    const { harness, ids } = await backfilled();
    await harness.t.run((ctx) => forceOpportunityState(ctx, ids[name], { lostByUserId: harness.closerId }));

    const error = (await harness.run("assertDealStages"))?.error;
    expect(error).toContain(ids[name]);
    expect(error).toContain(`and lostByUserId ${harness.closerId}`);
  });

  it("names a Follow-up deal with two pending reschedule links", async () => {
    const { harness, ids } = await backfilled();
    await harness.t.run(async (ctx) => {
      const deal = (await ctx.db.get("opportunities", ids.linkSent))!;
      for (const createdAt of [1, 2]) {
        await ctx.db.insert("followUps", {
          tenantId: harness.tenantId,
          opportunityId: deal._id,
          leadId: deal.leadId,
          closerId: harness.closerId,
          type: "scheduling_link",
          schedulingLinkUrl: "https://calendly.com/closer/test",
          reason: "no_show_follow_up",
          status: "pending",
          createdAt,
        });
      }
    });

    const error = (await harness.run("assertDealStages"))?.error;
    expect(error).toContain(ids.linkSent);
    expect(error).toContain("2 pending reschedule links");
  });
});

describe("backfillOpportunityByStage and verifyStageCounts", () => {
  it("enters every deal, after which the stage counts agree with the status counts", async () => {
    const { harness } = await backfilled();
    const verify = () =>
      harness.t.query(internal.migrations.verifyStageCounts, { tenantId: harness.tenantId });

    const before = await verify();
    expect(before.ok).toBe(false);
    expect(before.total).toEqual({ byStage: 0, byStatus: 14, match: false });

    expect((await harness.run("backfillOpportunityByStage"))?.error).toBeUndefined();

    const after = await verify();
    expect(after.ok).toBe(true);
    expect(after.stageCounts).toEqual({
      qualified: 1,
      booked: 1,
      call_held: 1,
      follow_up: 2,
      won: 1,
      lost: 8,
    });
    expect(after.checks).toEqual([
      { positions: ["qualified"], statuses: ["qualified_pending"], byStage: 1, byStatus: 1, match: true },
      { positions: ["booked", "call_held"], statuses: ["scheduled"], byStage: 2, byStatus: 2, match: true },
      {
        positions: ["follow_up"],
        statuses: ["follow_up_scheduled", "reschedule_link_sent"],
        byStage: 2,
        byStatus: 2,
        match: true,
      },
      { positions: ["won"], statuses: ["payment_received"], byStage: 1, byStatus: 1, match: true },
      { positions: ["lost"], statuses: ["lost", "canceled", "no_show"], byStage: 8, byStatus: 8, match: true },
    ]);
    expect(after.total).toEqual({ byStage: 14, byStatus: 14, match: true });
  });

  it("enters a deal once, and keeps the count as the deal moves", async () => {
    const { harness, ids } = await backfilled();
    await harness.run("backfillOpportunityByStage");
    expect((await harness.rerun("backfillOpportunityByStage"))?.error).toBeUndefined();
    expect((await harness.t.query(internal.migrations.verifyStageCounts, { tenantId: harness.tenantId })).ok).toBe(true);

    const { transitionOpportunity } = await import("../lib/opportunityActivity");
    await harness.t.run((ctx) =>
      transitionOpportunity(ctx, ids.booked, { to: "no_show", fields: { noShowAt: 1 }, source: "system" }),
    );

    const after = await harness.t.query(internal.migrations.verifyStageCounts, { tenantId: harness.tenantId });
    expect(after.ok).toBe(true);
    expect([after.stageCounts.booked, after.stageCounts.lost]).toEqual([0, 9]);
    // Every lost deal but none is the closer's: the seeded Qualified deal has no closer.
    expect(await harness.t.run((ctx) => countAtStage(ctx, harness.tenantId, "closed", "lost", harness.closerId))).toBe(9);
  });
});
