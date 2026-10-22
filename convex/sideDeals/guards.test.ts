import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  expectGuard,
  guardDealIn,
  guardHarness,
  guardStates,
  todaysGuards as today,
  type GuardHarness,
  type GuardState,
} from "../../tests/dealGuardFixtures";

// Side deals are worked at the same states as before PR 7: a `scheduled`
// side deal is Call held (docs/plans/phase-5-deal-status.md §5, §6.9).

const sideDealStates = guardStates("side_deal");

async function sideDealPayment(harness: GuardHarness, opportunityId: Id<"opportunities">) {
  return await harness.t.run((ctx) =>
    ctx.db.insert("paymentRecords", {
      tenantId: harness.tenantId,
      opportunityId,
      attributedCloserId: harness.closerId,
      recordedByUserId: harness.closerId,
      commissionable: true,
      amountMinor: 50_000,
      currency: "USD",
      programId: harness.programId,
      programName: "Program",
      paymentType: "pif",
      status: "recorded",
      recordedAt: 1_500,
      origin: "closer_side_deal",
    }),
  );
}

describe("side deal writes", () => {
  it.each(sideDealStates)("logPayment: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.closer.mutation(api.sideDeals.logPayment.logPayment, {
          opportunityId,
          amount: 500,
          currency: "USD",
          programId: harness.programId,
          paymentType: "pif",
        }),
      today.takePayment(state.status),
    );
  });

  it.each(sideDealStates)("markLost: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    await expectGuard(
      harness,
      opportunityId,
      () => harness.closer.mutation(api.sideDeals.markLost.markLost, { opportunityId }),
      today.markLost(state.status),
    );
  });

  it.each(sideDealStates)("voidPayment: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    const paymentId = await sideDealPayment(harness, opportunityId);
    await expectGuard(
      harness,
      opportunityId,
      () => harness.admin.mutation(api.sideDeals.voidPayment.voidPayment, { paymentId, reason: "refund" }),
      today.won(state.status),
    );
  });

  it.each(sideDealStates)("deleteEmptyOpportunity: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    const allowed = today.sideDealScheduled(state.status, state.source) && state.task === undefined;
    if (allowed) {
      await harness.closer.mutation(api.sideDeals.deleteEmptyOpportunity.deleteEmptyOpportunity, {
        opportunityId,
      });
      expect(await harness.t.run((ctx) => ctx.db.get("opportunities", opportunityId))).toBeNull();
      return;
    }
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.closer.mutation(api.sideDeals.deleteEmptyOpportunity.deleteEmptyOpportunity, {
          opportunityId,
        }),
      false,
    );
  });

  it.each(guardStates("calendly").filter((state) => state.status === "scheduled"))(
    "deleteEmptyOpportunity refuses a deal that isn't a side deal: $label",
    async (state) => {
      const harness = await guardHarness();
      const { opportunityId } = await guardDealIn(harness, state);
      await expectGuard(
        harness,
        opportunityId,
        () =>
          harness.closer.mutation(api.sideDeals.deleteEmptyOpportunity.deleteEmptyOpportunity, {
            opportunityId,
          }),
        false,
      );
    },
  );
});

describe("nudgeStaleSideDeals", () => {
  it("nudges the side deals it nudged before, and no other deal", async () => {
    const harness = await guardHarness();
    const states = [...sideDealStates, ...guardStates("calendly")];
    const deals: { state: GuardState; opportunityId: Id<"opportunities"> }[] = [];
    for (const state of states) {
      const { opportunityId } = await guardDealIn(harness, state);
      deals.push({ state, opportunityId });
    }

    await harness.t.mutation(internal.opportunities.staleness.nudgeStaleSideDeals, {
      cutoff: Date.now(),
    });

    const nudged = await harness.t.run(async (ctx) => {
      const result: Record<string, boolean> = {};
      for (const { state, opportunityId } of deals) {
        const nudge = await ctx.db
          .query("followUps")
          .withIndex("by_opportunityId_and_status_and_reason", (q) =>
            q.eq("opportunityId", opportunityId).eq("status", "pending").eq("reason", "stale_opportunity_nudge"),
          )
          .first();
        result[`${state.label} (${state.source})`] = nudge !== null;
      }
      return result;
    });
    expect(nudged).toEqual(
      Object.fromEntries(
        states.map((state) => [
          `${state.label} (${state.source})`,
          today.sideDealScheduled(state.status, state.source) && state.task === undefined,
        ]),
      ),
    );
  });
});
