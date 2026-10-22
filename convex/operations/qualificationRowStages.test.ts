import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { transitionOpportunity } from "../lib/opportunityActivity";
import type { OpportunityStatus } from "../opportunities/stages";
import type { DealSource } from "../opportunities/stages";
import { rebuildQualificationRow } from "./projections";
import { insertDeal } from "../../tests/dealStageFixtures";
import {
  insertQualification,
  insertWrittenDeal,
  qualificationRowOf,
} from "../../tests/dealStateFixtures";
import { enrollmentHarness, type EnrollmentHarness } from "../../tests/enrollmentFixtures";
import { forceOpportunityState } from "../../tests/opportunityFixtures";

// A qualification row carries its deal's stage and outcome beside the status
// (docs/plans/phase-5-deal-status.md §3.2, §10.3).

afterEach(() => vi.useRealTimers());

const QUALIFIED_AT = Date.parse("2026-09-01T12:00:00Z");

async function qualifiedDeal(
  harness: EnrollmentHarness,
  status: OpportunityStatus,
  source: DealSource = "slack_qualified",
) {
  return await harness.t.run(async (ctx) => {
    const opportunityId = await insertWrittenDeal(ctx, { tenantId: harness.tenantId, status, source });
    const eventId = await insertQualification(ctx, {
      tenantId: harness.tenantId,
      qualifiedAt: QUALIFIED_AT,
      opportunityId,
    });
    return { opportunityId, eventId };
  });
}

async function rowOf(harness: EnrollmentHarness, eventId: Id<"slackQualificationEvents">) {
  const row = await harness.t.run((ctx) => qualificationRowOf(ctx, eventId));
  return { status: row.opportunityStatus, stage: row.dealStage, outcome: row.dealOutcome };
}

describe("the qualification row's stage and outcome", () => {
  it.each([
    ["qualified_pending", "slack_qualified", "qualified", "open"],
    ["scheduled", "slack_qualified", "booked", "open"],
    ["scheduled", "side_deal", "call_held", "open"],
    ["follow_up_scheduled", "slack_qualified", "follow_up", "open"],
    ["payment_received", "slack_qualified", "closed", "won"],
    ["canceled", "slack_qualified", "closed", "lost"],
    ["lost", "slack_qualified", "closed", "lost"],
  ] as const)("copies a %s %s deal's as %s/%s, beside the status", async (status, source, stage, outcome) => {
    const harness = await enrollmentHarness();
    const { eventId } = await qualifiedDeal(harness, status, source);

    expect(await rowOf(harness, eventId)).toEqual({ status, stage, outcome });
  });

  it("takes a deal's stage from its status before the backfill wrote it", async () => {
    const harness = await enrollmentHarness();
    const eventId = await harness.t.run(async (ctx) => {
      const opportunityId = await insertDeal(ctx, {
        tenantId: harness.tenantId,
        status: "no_show",
        source: "slack_qualified",
        written: false,
      });
      return await insertQualification(ctx, { tenantId: harness.tenantId, qualifiedAt: QUALIFIED_AT, opportunityId });
    });

    expect(await rowOf(harness, eventId)).toEqual({ status: "no_show", stage: "closed", outcome: "lost" });
  });

  it("has none on a qualification with no deal, and drops them when the deal goes", async () => {
    const harness = await enrollmentHarness();
    const unlinked = await harness.t.run((ctx) =>
      insertQualification(ctx, { tenantId: harness.tenantId, qualifiedAt: QUALIFIED_AT }),
    );
    expect(await rowOf(harness, unlinked)).toEqual({ status: undefined, stage: undefined, outcome: undefined });

    const { eventId } = await qualifiedDeal(harness, "scheduled");
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("slackQualificationEvents", eventId, { opportunityId: undefined });
      await rebuildQualificationRow(ctx, eventId);
    });
    const row = await harness.t.run((ctx) => qualificationRowOf(ctx, eventId));
    expect("dealStage" in row || "dealOutcome" in row).toBe(false);
  });

  it("follows the deal through a transition", async () => {
    const harness = await enrollmentHarness();
    const { opportunityId, eventId } = await qualifiedDeal(harness, "scheduled");

    await harness.t.run((ctx) =>
      transitionOpportunity(ctx, opportunityId, {
        to: { stage: "closed", outcome: "lost" },
        fields: { noShowAt: 1, lostReason: "no_show", lostAt: 1 },
        source: "system",
      }),
    );

    expect(await rowOf(harness, eventId)).toEqual({ status: "no_show", stage: "closed", outcome: "lost" });
  });

  it("is a filter of the qualification search", async () => {
    const harness = await enrollmentHarness();
    const { eventId } = await qualifiedDeal(harness, "payment_received");
    await qualifiedDeal(harness, "lost");

    const found = await harness.t.run((ctx) =>
      ctx.db
        .query("operationsQualificationRows")
        .withSearchIndex("search_qualification_rows", (q) =>
          q
            .search("searchText", "qualified")
            .eq("tenantId", harness.tenantId)
            .eq("dealStage", "closed")
            .eq("dealOutcome", "won"),
        )
        .take(10),
    );
    expect(found.map((row) => row.qualificationEventId)).toEqual([eventId]);
  });
});

describe("rebuildQualificationRows and assertQualificationRowsCurrent", () => {
  it("passes on rows that copy their deal", async () => {
    const harness = await enrollmentHarness();
    await qualifiedDeal(harness, "scheduled");
    await harness.t.run((ctx) => insertQualification(ctx, { tenantId: harness.tenantId, qualifiedAt: QUALIFIED_AT }));

    expect((await harness.run("assertQualificationRowsCurrent"))?.error).toBeUndefined();
  });

  it("names a row from before PR 3, with no stage, and the rebuild writes it", async () => {
    const harness = await enrollmentHarness();
    const { eventId } = await qualifiedDeal(harness, "canceled");
    await harness.t.run(async (ctx) => {
      const row = await qualificationRowOf(ctx, eventId);
      await ctx.db.patch("operationsQualificationRows", row._id, { dealStage: undefined, dealOutcome: undefined });
    });

    const error = (await harness.run("assertQualificationRowsCurrent"))?.error;
    expect(error).toContain(`Qualification event ${eventId} has a stale qualification row`);

    expect((await harness.run("rebuildQualificationRows"))?.error).toBeUndefined();
    expect(await rowOf(harness, eventId)).toEqual({ status: "canceled", stage: "closed", outcome: "lost" });
    expect((await harness.rerun("assertQualificationRowsCurrent"))?.error).toBeUndefined();
  });

  it.each([
    ["stage", { stage: "follow_up" as const }],
    ["outcome", { stage: "closed" as const, outcome: "won" as const }],
  ])("names a row whose deal's %s moved without it", async (_label, patch) => {
    const harness = await enrollmentHarness();
    const { opportunityId, eventId } = await qualifiedDeal(harness, "lost");
    await harness.t.run((ctx) => forceOpportunityState(ctx, opportunityId, patch));

    const error = (await harness.run("assertQualificationRowsCurrent"))?.error;
    expect(error).toContain(`Qualification event ${eventId} has a stale qualification row`);
  });

  it("names a row with a stage but no deal", async () => {
    const harness = await enrollmentHarness();
    const eventId = await harness.t.run(async (ctx) => {
      const eventId = await insertQualification(ctx, { tenantId: harness.tenantId, qualifiedAt: QUALIFIED_AT });
      const row = await qualificationRowOf(ctx, eventId);
      await ctx.db.patch("operationsQualificationRows", row._id, { dealStage: "qualified", dealOutcome: "open" });
      return eventId;
    });

    const error = (await harness.run("assertQualificationRowsCurrent"))?.error;
    expect(error).toContain(`Qualification event ${eventId} has a stale qualification row`);
  });
});
