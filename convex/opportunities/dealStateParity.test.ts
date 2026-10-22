import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { OPPORTUNITY_STATUSES, type OpportunityStatus } from "../lib/statusTransitions";
import type { DealSource } from "./stages";
import { bookingHarness } from "../../tests/bookingHarness";
import { forceOpportunityState } from "../../tests/opportunityFixtures";
import {
  insertDealTask,
  insertOtherTenant,
  insertWrittenDeal,
} from "../../tests/dealStateFixtures";

// The parity queries of docs/plans/phase-5-deal-status.md §10.4 that PR 3
// adds: compareDealState and compareQualificationQueue.

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

/** One deal at every status, as the dual write leaves it, with its link. */
async function seedEveryStatus(harness: Harness) {
  return await harness.t.run(async (ctx) => {
    const ids = {} as Record<OpportunityStatus, Id<"opportunities">>;
    for (const status of OPPORTUNITY_STATUSES) {
      const source: DealSource = status === "qualified_pending" ? "slack_qualified" : "calendly";
      ids[status] = await insertWrittenDeal(ctx, { tenantId: harness.tenantId, status, source });
    }
    await insertDealTask(ctx, ids.reschedule_link_sent);
    return ids;
  });
}

async function firstPendingRescheduleLink(
  harness: Harness,
  opportunityId: Id<"opportunities">,
): Promise<Id<"followUps">> {
  return await harness.t.run(async (ctx) => {
    const [link] = await ctx.db
      .query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) =>
        q.eq("opportunityId", opportunityId).eq("status", "pending").eq("reason", "no_show_follow_up"),
      )
      .take(1);
    return link._id;
  });
}

describe("compareDealState", () => {
  type Result = {
    checked: number;
    mismatches: { opportunityId: Id<"opportunities">; status: string; legacy: string | null }[];
    continueCursor: string;
    isDone: boolean;
  };
  const compare = (harness: Harness, cursor: string | null = null, numItems?: number): Promise<Result> =>
    harness.t.query(internal.opportunities.stageParity.compareDealState, {
      tenantId: harness.tenantId,
      cursor,
      numItems,
    });

  it("finds no difference on deals the dual write left", async () => {
    const harness = await bookingHarness();
    await seedEveryStatus(harness);
    await harness.t.run(async (ctx) => {
      await insertWrittenDeal(ctx, { tenantId: harness.tenantId, status: "scheduled", source: "side_deal" });
      const followUp = await insertWrittenDeal(ctx, { tenantId: harness.tenantId, status: "follow_up_scheduled" });
      // An ordinary scheduling link isn't a reschedule link.
      await insertDealTask(ctx, followUp, { reason: "closer_initiated" });
    });

    expect(await compare(harness)).toEqual({
      checked: 10,
      mismatches: [],
      continueCursor: expect.any(String),
      isDone: true,
    });
  });

  it("lists every mismatch, not the first", async () => {
    const harness = await bookingHarness();
    const ids = await seedEveryStatus(harness);
    const linkId = await firstPendingRescheduleLink(harness, ids.reschedule_link_sent);
    await harness.t.run(async (ctx) => {
      await insertDealTask(ctx, ids.follow_up_scheduled);
      await ctx.db.patch("followUps", linkId, { status: "expired" });
      await forceOpportunityState(ctx, ids.lost, { lostReason: "canceled" });
    });

    const result = await compare(harness);
    expect(result.checked).toBe(8);
    expect(result.mismatches).toHaveLength(3);
    expect(result.mismatches).toEqual(
      expect.arrayContaining([
        { opportunityId: ids.follow_up_scheduled, status: "follow_up_scheduled", legacy: "reschedule_link_sent" },
        { opportunityId: ids.reschedule_link_sent, status: "reschedule_link_sent", legacy: "follow_up_scheduled" },
        { opportunityId: ids.lost, status: "lost", legacy: "canceled" },
      ]),
    );
  });

  it("reports a deal whose stage and outcome pair isn't allowed, with no rebuilt status", async () => {
    const harness = await bookingHarness();
    const ids = await seedEveryStatus(harness);
    await harness.t.run((ctx) => forceOpportunityState(ctx, ids.payment_received, { outcome: "open" }));

    expect((await compare(harness)).mismatches).toEqual([
      { opportunityId: ids.payment_received, status: "payment_received", legacy: null },
    ]);
  });

  it("pages through the tenant's deals, and only the tenant's", async () => {
    const harness = await bookingHarness();
    const ids = await seedEveryStatus(harness);
    await harness.t.run(async (ctx) => {
      const other = await insertOtherTenant(ctx);
      const otherDeal = await insertWrittenDeal(ctx, { tenantId: other, status: "follow_up_scheduled" });
      await insertDealTask(ctx, otherDeal);
      await insertDealTask(ctx, ids.follow_up_scheduled);
    });

    let cursor: string | null = null;
    let checked = 0;
    let pages = 0;
    const mismatches: Result["mismatches"] = [];
    for (;;) {
      const page = await compare(harness, cursor, 3);
      checked += page.checked;
      mismatches.push(...page.mismatches);
      pages += 1;
      cursor = page.continueCursor;
      if (page.isDone) break;
    }
    expect(checked).toBe(8);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(mismatches).toEqual([
      { opportunityId: ids.follow_up_scheduled, status: "follow_up_scheduled", legacy: "reschedule_link_sent" },
    ]);
  });

  it.each([0, 501, 2.5])("refuses a page of %s deals", async (numItems) => {
    const harness = await bookingHarness();
    await expect(compare(harness, null, numItems)).rejects.toThrow(
      "numItems must be a whole number from 1 to 500",
    );
  });
});
