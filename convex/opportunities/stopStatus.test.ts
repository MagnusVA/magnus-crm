import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { transitionOpportunity } from "../lib/opportunityActivity";
import { meetingDayKey } from "../operations/meetingStats";
import { opportunityByStage } from "../reporting/aggregates";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { insertDealTask } from "../../tests/dealStateFixtures";
import { countAtStage, harnessCloserId, insertDeal } from "../../tests/dealStageFixtures";
import {
  book,
  enrollmentHarness,
  sideDeal,
  type EnrollmentHarness,
} from "../../tests/enrollmentFixtures";
import { qualifyInSlack } from "../../tests/stopStatusFixtures";
import { DEAL_POSITIONS, dealPosition, stageOfPosition } from "./stages";

// Phase 5 (docs/plans/phase-5-deal-status.md §9): no deal stores a status,
// and the schema has no field for one or for any copy of it.
// `opportunityByStage` is on its strict methods.

afterEach(() => vi.useRealTimers());

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

describe("the stage, with no status", () => {
  it("a Slack qualification's row carries the stage, and its search text no status", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await qualifyInSlack(harness);

    expect(await readDeal(harness, opportunityId)).toMatchObject({ stage: "qualified", outcome: "open" });
    const rows = await harness.t.run((ctx) => ctx.db.query("operationsQualificationRows").take(10));
    expect(rows.map((row) => [row.dealStage, row.dealOutcome])).toEqual([["qualified", "open"]]);
    expect(rows[0].searchText).not.toContain("qualified_pending");
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
            table: deals.filter((deal) => dealPosition(deal.stage, deal.outcome) === position).length,
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
});

describe("assertDealStages", () => {
  it("passes on deals the write paths left", async () => {
    const harness = await enrollmentHarness();
    await book(harness, "plain", "plain@example.com");
    await qualifyInSlack(harness);

    expect((await harness.run("assertDealStages"))?.error).toBeUndefined();
  });

  it("names a deal with a pending reschedule link off Follow-up", async () => {
    const harness = await enrollmentHarness();
    const { opportunityId } = await book(harness, "link");
    await harness.t.run((ctx) => insertDealTask(ctx, opportunityId));

    expect((await harness.run("assertDealStages"))?.error).toContain(`Opportunity ${opportunityId}`);
  });
});
