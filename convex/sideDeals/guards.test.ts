import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { storeProofFile } from "../../tests/proofFixtures";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import {
  FIXTURE_NOW,
  insertProviderBinding,
  providerPaymentFixture,
  seedBillingWin,
} from "../../tests/providerPaymentFixtures";

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
      async () =>
        harness.closer.mutation(api.sideDeals.logPayment.logPayment, {
          proofFileId: await storeProofFile(harness.t),
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

it.each([1, 101])("voiding a side-deal payment clears its allocation with %i membership bindings", async (bindingCount) => {
  vi.useFakeTimers();
  try {
    const fixture = await providerPaymentFixture({ source: "side_deal" });
    const { t, admin, closer, dealId, personId, providerPaymentId, programId } = fixture;
    const { paymentId } = await closer.mutation(api.sideDeals.logPayment.logPayment, {
      opportunityId: dealId!, amount: 100, currency: "USD", paymentType: "pif", programId,
      proofFileId: await storeProofFile(t),
    });
    await admin.mutation(api.payments.review.linkToPaymentRecord, {
      providerPaymentId, paymentRecordId: paymentId, expectedAllocationRevision: 0,
    });
    const bindingIds = await t.run(async (ctx) => {
      const ids = [];
      for (let i = 0; i < bindingCount; i++) {
        ids.push(await insertProviderBinding(ctx, {
          ...fixture, externalId: `mem_side_fixture_${i}`,
          binding: {
            kind: "membership_deal", leadId: personId,
            opportunityId: dealId!, anchorPaymentRecordId: paymentId,
          },
        }));
      }
      return ids;
    });
    await admin.mutation(api.sideDeals.voidPayment.voidPayment, { paymentId, reason: "Synthetic correction" });
    const state = await t.run(async (ctx) => ({
      record: await ctx.db.get("paymentRecords", paymentId),
      fact: await ctx.db.get("providerPayments", providerPaymentId),
    }));
    expect(state.record).toMatchObject({ status: "disputed", providerPaymentId });
    expect(state.fact).toMatchObject({ reviewState: "needs_person", allocationRevision: 2 });
    expect(state.fact?.paymentRecordId).toBeUndefined();
    expect(state.fact?.resolvedAt).toBeUndefined();

    const loadBindings = () => t.run((ctx) => Promise.all(bindingIds.map((id) => ctx.db.get("paymentProviderBindings", id))));
    expect((await loadBindings()).filter((binding) => binding?.enabled === false)).toHaveLength(Math.min(100, bindingCount));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    for (const binding of await loadBindings()) {
      expect(binding).toMatchObject({ enabled: false, disabledReason: "anchor_undone", version: 2 });
    }
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

describe("the side-deal void through the shared exclusion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXTURE_NOW);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function depositAndWhopInstalment() {
    const fixture = await providerPaymentFixture({ source: "side_deal", fact: { reviewState: "needs_person" } });
    const { t, closer, dealId, programId, tenantId } = fixture;
    const { paymentId: depositId } = await closer.mutation(api.sideDeals.logPayment.logPayment, {
      opportunityId: dealId!, amount: 100, currency: "USD", paymentType: "deposit", programId,
      proofFileId: await storeProofFile(t),
    });
    const instalmentAt = FIXTURE_NOW + 1000;
    const { paymentRecordId: instalmentId } = await t.run((ctx) => seedBillingWin(ctx, {
      tenantId, opportunityId: dealId!, providerPaymentId: fixture.providerPaymentId, programId,
      closerId: fixture.closerId, approverId: fixture.adminId, recordedAt: instalmentAt,
    }));
    const invariant = () => assertPaymentInvariants(t, { tenantId });
    await invariant();
    return { ...fixture, depositId, instalmentId, instalmentAt, invariant };
  }

  it("keeps the deal won when the deposit is voided and a Whop instalment still counts", async () => {
    const f = await depositAndWhopInstalment();
    await f.admin.mutation(api.sideDeals.voidPayment.voidPayment, { paymentId: f.depositId, reason: "Typed twice" });
    const state = await f.t.run(async (ctx) => ({
      deal: await ctx.db.get("opportunities", f.dealId!),
      deposit: await ctx.db.get("paymentRecords", f.depositId),
      instalment: await ctx.db.get("paymentRecords", f.instalmentId),
      corrections: await ctx.db.query("paymentCorrections").take(5),
      voided: await ctx.db.query("domainEvents")
        .withIndex("by_tenantId_and_eventType_and_occurredAt", (q) => q.eq("tenantId", f.tenantId).eq("eventType", "payment.voided"))
        .take(5),
    }));
    expect(state.deal).toMatchObject({ stage: "closed", outcome: "won", paymentReceivedAt: f.instalmentAt });
    expect(state.deposit?.status).toBe("disputed");
    expect(state.instalment?.status).toBe("recorded");
    expect(state.corrections).toMatchObject([{ cause: "voided", level: "reviewed", result: "kept_won" }]);
    // The typed reason stays on the event, and only there.
    expect(state.voided).toMatchObject([{ reason: "Typed twice", toStatus: "disputed" }]);
    expect(JSON.parse(state.voided[0].metadata!)).toMatchObject({ sideDeal: true, cause: "voided", result: "kept_won" });
    await f.invariant();

    // The won side deal still takes the next payment.
    vi.setSystemTime(FIXTURE_NOW + 2000);
    await f.closer.mutation(api.closer.additionalPayment.recordAdditionalPayment, {
      opportunityId: f.dealId!, amount: 50, currency: "USD", paymentType: "split", proofFileId: await storeProofFile(f.t),
      provider: { kind: "different_money", pins: [{ providerPaymentId: f.providerPaymentId, allocationRevision: 1 }] },
    });
    await f.invariant();
  });

  it("closes the deal lost with the reserved code when its only payment is voided", async () => {
    const f = await depositAndWhopInstalment();
    await f.admin.mutation(api.sideDeals.voidPayment.voidPayment, { paymentId: f.depositId, reason: "Typed twice" });
    await f.admin.mutation(api.sideDeals.voidPayment.voidPayment, { paymentId: f.instalmentId, reason: "Refunded" });
    const deal = await f.t.run((ctx) => ctx.db.get("opportunities", f.dealId!));
    expect(deal).toMatchObject({ outcome: "lost", lostReason: "payment_excluded", lostByUserId: f.adminId });
    expect(deal?.paymentReceivedAt).toBeUndefined();
    await f.invariant();
    await expect(f.admin.mutation(api.sideDeals.voidPayment.voidPayment, { paymentId: f.instalmentId, reason: "Again" }))
      .rejects.toThrow("Already voided.");
  });

  it("refuses Billing's undo and a Follow-up correction on a side deal", async () => {
    const f = await depositAndWhopInstalment();
    await f.admin.mutation(api.sideDeals.voidPayment.voidPayment, { paymentId: f.depositId, reason: "Typed twice" });
    const { fingerprint } = await f.admin.query(api.payments.exclude.previewExclusion, {
      paymentRecordId: f.instalmentId, cause: "refund",
    });
    const args = { paymentRecordId: f.instalmentId, cause: "refund", expectedFingerprint: fingerprint } as const;
    expect(await f.admin.mutation(api.payments.exclude.excludePayment, { ...args, level: "undo" }))
      .toEqual({ ok: false, code: "needs_review" });
    expect(await f.admin.mutation(api.payments.exclude.excludePayment, {
      ...args, level: "reviewed", disposition: "follow_up", followUpContactMethod: "call",
    })).toEqual({ ok: false, code: "disposition_not_allowed" });
    expect((await f.admin.query(api.payments.exclude.previewExclusion, { paymentRecordId: f.instalmentId, cause: "refund" })))
      .toMatchObject({ allowedDispositions: ["lost"], undo: { allowed: false } });
    await f.invariant();
  });
});
