import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { OPPORTUNITY_STATUSES, type OpportunityStatus } from "./stages";
import type { DealSource } from "./stages";
import { bookingHarness } from "../../tests/bookingHarness";
import { forceOpportunityState } from "../../tests/opportunityFixtures";
import {
  insertDealTask,
  insertOtherTenant,
  insertQualification,
  insertWrittenDeal,
  qualificationRowOf,
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
    mismatches: { opportunityId: Id<"opportunities">; status: string | null; legacy: string | null }[];
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

describe("compareQualificationQueue", () => {
  const AFTER = Date.parse("2026-09-01T00:00:00Z");
  const BEFORE = Date.parse("2026-10-01T00:00:00Z");
  const IN_RANGE = Date.parse("2026-09-15T12:00:00Z");

  const compare = (harness: Harness, overrides: { qualifiedAfter?: number; qualifiedBefore?: number; maxRowsPerRead?: number } = {}) =>
    harness.t.query(internal.opportunities.stageParity.compareQualificationQueue, {
      tenantId: harness.tenantId,
      qualifiedAfter: AFTER,
      qualifiedBefore: BEFORE,
      ...overrides,
    });

  /** A qualification row on a new deal at `status`. */
  async function qualifiedRow(
    harness: Harness,
    status: OpportunityStatus,
    options: { source?: DealSource; qualifiedAt?: number; tenantId?: Id<"tenants"> } = {},
  ) {
    return await harness.t.run(async (ctx) => {
      const tenantId = options.tenantId ?? harness.tenantId;
      const opportunityId = await insertWrittenDeal(ctx, {
        tenantId,
        status,
        source: options.source ?? "slack_qualified",
      });
      const eventId = await insertQualification(ctx, {
        tenantId,
        qualifiedAt: options.qualifiedAt ?? IN_RANGE,
        opportunityId,
      });
      return { opportunityId, eventId };
    });
  }

  async function seedQueue(harness: Harness) {
    const rows = {} as Record<OpportunityStatus, Awaited<ReturnType<typeof qualifiedRow>>>;
    for (const status of OPPORTUNITY_STATUSES) {
      rows[status] = await qualifiedRow(harness, status);
    }
    const sideDeal = await qualifiedRow(harness, "scheduled", { source: "side_deal" });
    return { rows, sideDeal };
  }

  const matching = [
    { positions: ["qualified"], statuses: ["qualified_pending"], byStage: 1, byStatus: 1, match: true, truncated: false },
    { positions: ["booked", "call_held"], statuses: ["scheduled"], byStage: 2, byStatus: 2, match: true, truncated: false },
    {
      positions: ["follow_up"],
      statuses: ["follow_up_scheduled", "reschedule_link_sent"],
      byStage: 2,
      byStatus: 2,
      match: true,
      truncated: false,
    },
    { positions: ["won"], statuses: ["payment_received"], byStage: 1, byStatus: 1, match: true, truncated: false },
    { positions: ["lost"], statuses: ["lost", "canceled", "no_show"], byStage: 3, byStatus: 3, match: true, truncated: false },
  ];

  it("counts each position's rows both ways, in the range and the tenant only", async () => {
    const harness = await bookingHarness();
    await seedQueue(harness);
    // Outside the range ([after, before)), with no deal, or another tenant's.
    await qualifiedRow(harness, "lost", { qualifiedAt: AFTER - 1 });
    await qualifiedRow(harness, "lost", { qualifiedAt: BEFORE });
    await harness.t.run((ctx) => insertQualification(ctx, { tenantId: harness.tenantId, qualifiedAt: IN_RANGE }));
    const other = await harness.t.run((ctx) => insertOtherTenant(ctx));
    await qualifiedRow(harness, "lost", { tenantId: other });

    expect(await compare(harness)).toEqual({
      stageCounts: { qualified: 1, booked: 1, call_held: 1, follow_up: 2, won: 1, lost: 3 },
      checks: matching,
      truncated: false,
      ok: true,
    });
  });

  it("finds the rows the stage filter misses: a row from before PR 3, and one left behind", async () => {
    const harness = await bookingHarness();
    const { rows } = await seedQueue(harness);
    await harness.t.run(async (ctx) => {
      const unwritten = await qualificationRowOf(ctx, rows.canceled.eventId);
      await ctx.db.patch("operationsQualificationRows", unwritten._id, { dealStage: undefined, dealOutcome: undefined });
      const stale = await qualificationRowOf(ctx, rows.payment_received.eventId);
      await ctx.db.patch("operationsQualificationRows", stale._id, { dealStage: "booked", dealOutcome: "open" });
    });

    const result = await compare(harness);
    expect(result.ok).toBe(false);
    expect(result.checks.filter((check) => !check.match)).toEqual([
      { positions: ["booked", "call_held"], statuses: ["scheduled"], byStage: 3, byStatus: 2, match: false, truncated: false },
      { positions: ["won"], statuses: ["payment_received"], byStage: 0, byStatus: 1, match: false, truncated: false },
      { positions: ["lost"], statuses: ["lost", "canceled", "no_show"], byStage: 2, byStatus: 3, match: false, truncated: false },
    ]);
  });

  it("stops at the read cap and says so, never matching a check it cut short", async () => {
    const harness = await bookingHarness();
    await seedQueue(harness);

    const result = await compare(harness, { maxRowsPerRead: 1 });
    expect(result.truncated).toBe(true);
    expect(result.ok).toBe(false);
    const lost = result.checks.find((check) => check.positions.includes("lost"));
    // Each of the three statuses has one row, so only the stage read is cut.
    expect(lost).toEqual({
      positions: ["lost"],
      statuses: ["lost", "canceled", "no_show"],
      byStage: 1,
      byStatus: 3,
      match: false,
      truncated: true,
    });
    const qualified = result.checks.find((check) => check.positions.includes("qualified"));
    expect(qualified).toMatchObject({ byStage: 1, byStatus: 1, match: true, truncated: false });
  });

  it.each([
    ["an empty range", { qualifiedAfter: BEFORE, qualifiedBefore: BEFORE }, "qualifiedAfter must be before qualifiedBefore"],
    ["no read", { maxRowsPerRead: 0 }, "maxRowsPerRead must be a whole number from 1 to 500"],
    ["too many reads", { maxRowsPerRead: 501 }, "maxRowsPerRead must be a whole number from 1 to 500"],
  ])("refuses %s", async (_label, overrides, message) => {
    const harness = await bookingHarness();
    await expect(compare(harness, overrides)).rejects.toThrow(message);
  });
});
