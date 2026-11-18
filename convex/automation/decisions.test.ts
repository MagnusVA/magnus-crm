import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import { assertPaymentInvariants, seedProviderWin } from "../../tests/paymentInvariants";
import {
  automationFixtureApi, automationPaymentFixture, FIXTURE_NOW, FIXTURE_PAID_AT,
  insertProviderBinding, insertProviderDeal, seedReadyDecision, setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";
import { evaluateSubject, stopDecision } from "./decisions";
import { noteHumanResult } from "./humanResult";
import { paymentVetoKey, recordApplyReceipt } from "./receipts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

type Fixture = Awaited<ReturnType<typeof automationPaymentFixture>>;

const evaluate = (f: Fixture, now = FIXTURE_NOW) => f.t.run((ctx) => evaluateSubject(ctx, {
  tenantId: f.tenantId, providerPaymentId: f.providerPaymentId, cause: "sweep", now,
}));
const decisions = (f: Fixture) => f.t.run((ctx) => ctx.db.query("resultAutomationDecisions").take(50));
const invariant = (f: Fixture) => assertPaymentInvariants(f.t, { tenantId: f.tenantId });

async function readyFixture(options?: Parameters<typeof automationPaymentFixture>[0]) {
  const f = await automationPaymentFixture(options);
  await f.t.run((ctx) => setPaymentFixtureModes(ctx, f));
  return f;
}

describe("evaluateSubject", () => {
  it("returns the same untouched row for duplicate wake-ups and supersedes new input atomically", async () => {
    const f = await readyFixture({ fact: { productTitle: "Whop text", reviewState: "needs_person" } });
    const first = await evaluate(f);
    expect(first.decisionId).not.toBeNull();
    const snapshot = await decisions(f);
    expect(snapshot).toMatchObject([{ state: "ready", wouldWrite: true, proposal: { amountMinor: 10000 } }]);
    expect(snapshot[0].vetoKey).toBe(await paymentVetoKey(f.providerPaymentId, f.dealId!));
    await invariant(f);

    await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, { refreshGeneration: 12 }));
    const duplicates = await Promise.all([evaluate(f, FIXTURE_NOW + 1), evaluate(f, FIXTURE_NOW + 2)]);
    expect(duplicates).toEqual([first, first]);
    expect(await decisions(f)).toEqual(snapshot);
    await invariant(f);

    await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, { totalMinor: 10500 }));
    const changed = await evaluate(f);
    expect(changed.decisionId).not.toEqual(first.decisionId);
    expect(await decisions(f)).toMatchObject([
      { _id: first.decisionId, state: "superseded", supersededByDecisionId: changed.decisionId },
      { _id: changed.decisionId, state: "ready", proposal: { amountMinor: 10500 } },
    ]);
    await invariant(f);
  });

  it("can propose again after a system fence releases without a new source timestamp", async () => {
    const f = await readyFixture();
    const first = await evaluate(f);
    await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, {
      adverseFencedAt: FIXTURE_NOW, adverseFenceRevision: 1,
    }));
    await evaluate(f);
    expect((await decisions(f)).at(-1)).toMatchObject({ state: "needs_person", gates: ["dispute"] });
    await invariant(f);
    await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, { adverseFencedAt: undefined }));
    const released = await evaluate(f);
    expect(released).not.toEqual(first);
    expect((await decisions(f)).at(-1)).toMatchObject({ state: "ready", gates: [] });
    await invariant(f);
  });

  it("serializes concurrent first observations", async () => {
    const f = await readyFixture();
    const results = await Promise.all(Array.from({ length: 4 }, () => evaluate(f)));
    expect(new Set(results.map((result) => result.decisionId)).size).toBe(1);
    expect(await decisions(f)).toHaveLength(1);
    await invariant(f);
  });

  it("stores abstentions with grounded candidates and leaves several deals to Billing", async () => {
    const f = await readyFixture({ dealPosition: "qualified" });
    expect((await evaluate(f)).decisionId).not.toBeNull();
    expect(await decisions(f)).toMatchObject([{ state: "needs_person", gates: ["qualified_only"] }]);
    await invariant(f);
    await f.t.run((ctx) => insertProviderDeal(ctx, {
      tenantId: f.tenantId, leadId: f.personId, assignedCloserId: f.closerId,
    }));
    expect(await evaluate(f)).toEqual({ decisionId: null });
    expect(await decisions(f)).toMatchObject([{ state: "superseded" }]);
    await invariant(f);
  });

  it("holds a matching payment when a human result and a later policy version wake it", async () => {
    const f = await readyFixture();
    await evaluate(f);
    await f.t.run((ctx) => noteHumanResult(ctx, f.dealId!, { tenantId: f.tenantId, userId: f.adminId }));
    expect(await decisions(f)).toMatchObject([{ state: "stopped", stopCode: "human_result" }]);
    await invariant(f);
    const changed = await evaluate(f);
    await f.admin.mutation(automationFixtureApi.settings.setKindMode, { kind: "payment_win", mode: "shadow" });
    await f.owner.mutation(automationFixtureApi.settings.setKindMode, { kind: "payment_win", mode: "ask" });
    await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, { allocationRevision: 1 }));
    const newPolicy = await evaluate(f);
    expect(newPolicy).not.toEqual(changed);
    const row = await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", newPolicy.decisionId!));
    expect(row).toMatchObject({ state: "needs_person", gates: ["stood_down"], policyVersion: 3, humanResultRevision: 1 });
    await invariant(f);
  });

  it.each(["input_changed", "merged"] as const)(
    "releases an explicit %s stop only after a person changes allocation or mapping",
    async (code) => {
      const f = await readyFixture();
      const first = await evaluate(f);
      await f.t.run((ctx) => stopDecision(ctx, first.decisionId!, { userId: f.adminId }, code));
      await invariant(f);
      await evaluate(f);
      expect((await decisions(f)).at(-1)).toMatchObject({ state: "needs_person", gates: ["stood_down"] });
      await invariant(f);
      await f.t.run((ctx) => ctx.db.patch("paymentProviderBindings", f.variantBindingId, { version: 2 }));
      await evaluate(f);
      expect((await decisions(f)).at(-1)).toMatchObject({ state: "ready", gates: [] });
      await invariant(f);
    },
  );

  it("uses the membership anchor and later type for a bound renewal and holds after the anchor is undone", async () => {
    const f = await readyFixture({ fact: { membershipId: "mem_fixture", externalPaymentId: "pay_anchor" } });
    const paymentId = await f.t.run(async (ctx) => {
      const anchorPaymentRecordId = await seedProviderWin(ctx, {
        ...f, opportunityId: f.dealId!, approverId: f.adminId, recordedAt: FIXTURE_PAID_AT,
      });
      await insertProviderBinding(ctx, {
        ...f, externalId: "mem_fixture",
        binding: { kind: "membership_deal", opportunityId: f.dealId!, leadId: f.personId, anchorPaymentRecordId },
      });
      await ctx.db.patch("paymentProviderBindings", f.variantBindingId, {
        binding: { kind: "variant_type", paymentType: "deposit", laterPaymentType: "monthly" }, version: 2,
      });
      const row = (await ctx.db.get("providerPayments", f.providerPaymentId))!;
      const { _id, _creationTime, ...facts } = row;
      expect(_id).toBe(f.providerPaymentId);
      expect(_creationTime).toBeDefined();
      return await ctx.db.insert("providerPayments", {
        ...facts, externalPaymentId: "pay_later", billingReason: "subscription_cycle", reviewState: "needs_person",
        paymentRecordId: undefined, allocationRevision: 0, resolvedAt: undefined, resolvedByUserId: undefined,
        opportunityId: undefined, leadId: undefined, matchMethod: undefined,
      });
    });
    const next = { ...f, providerPaymentId: paymentId };
    await evaluate(next);
    expect((await decisions(f)).at(-1)).toMatchObject({
      state: "ready", kind: "additional_payment", proposal: { paymentType: "monthly", programId: f.programId },
    });
    await invariant(f);
    await f.t.run(async (ctx) => {
      const binding = await ctx.db.query("paymentProviderBindings")
        .withIndex("by_tenantId_and_opportunityId_and_kind", (q) =>
          q.eq("tenantId", f.tenantId).eq("opportunityId", f.dealId!).eq("kind", "membership_deal")).first();
      await ctx.db.patch("paymentProviderBindings", binding!._id, { enabled: false, version: 2, disabledReason: "anchor_undone" });
    });
    await evaluate(next);
    expect((await decisions(f)).at(-1)).toMatchObject({
      state: "needs_person", kind: "additional_payment", gates: expect.arrayContaining(["won_deal_no_membership"]),
    });
    await invariant(f);
  });

  it("supersedes every other decision for a payment applied through a human writer", async () => {
    const f = await readyFixture();
    const { decisionId } = await evaluate(f);
    const [alternate, sibling] = await f.t.run(async (ctx) => {
      const other = await insertProviderDeal(ctx, { tenantId: f.tenantId, leadId: f.personId, position: "qualified" });
      const otherDecisionId = await seedReadyDecision(ctx, {
        tenantId: f.tenantId, leadId: f.personId, opportunityId: other, providerPaymentId: f.providerPaymentId,
      });
      await ctx.db.patch("resultAutomationDecisions", otherDecisionId, { state: "shadow" });
      const sameDeal = await seedReadyDecision(ctx, {
        tenantId: f.tenantId, leadId: f.personId, opportunityId: f.dealId, providerPaymentId: f.providerPaymentId,
      });
      await ctx.db.patch("resultAutomationDecisions", sameDeal, { state: "needs_person" });
      const paymentRecordId = await seedProviderWin(ctx, {
        ...f, opportunityId: f.dealId!, approverId: f.adminId, recordedAt: FIXTURE_PAID_AT,
      });
      await recordApplyReceipt(ctx, {
        ...f, decisionId: decisionId!, opportunityId: f.dealId!, paymentRecordId, now: FIXTURE_NOW,
        kind: "payment_win", approverUserId: f.adminId, appliedVia: "billing",
      });
      await noteHumanResult(ctx, f.dealId!, { tenantId: f.tenantId, userId: f.adminId }, { consumeDecisionId: decisionId! });
      return [otherDecisionId, sameDeal] as const;
    });
    expect(await decisions(f)).toMatchObject([
      { _id: decisionId, state: "applied", humanResultRevisionAfter: 1 },
      { _id: alternate, state: "superseded", supersededByDecisionId: decisionId },
      { _id: sibling, state: "superseded", supersededByDecisionId: decisionId },
    ]);
    const snapshot = await decisions(f);
    expect(await evaluate(f)).toEqual({ decisionId });
    expect(await decisions(f)).toEqual(snapshot);
    await invariant(f);
  });

  it("supersedes the entire subject on disconnect", async () => {
    const f = await readyFixture();
    const { decisionId } = await evaluate(f);
    await f.admin.mutation(api.payments.connection.disconnect, { connectionId: f.connectionId });
    expect(await decisions(f)).toMatchObject([{ _id: decisionId, state: "superseded" }]);
    expect(await evaluate(f)).toEqual({ decisionId: null });
    await invariant(f);
  });

  it("supersedes stale proposals when an active allocation is observed", async () => {
    const f = await readyFixture();
    const { decisionId } = await evaluate(f);
    await f.t.run((ctx) => seedProviderWin(ctx, {
      ...f, opportunityId: f.dealId!, approverId: f.adminId, recordedAt: FIXTURE_PAID_AT,
    }));
    const result = await f.t.mutation(automationFixtureApi.decisions.evaluateProviderPayment, {
      providerPaymentId: f.providerPaymentId, cause: "link",
    });
    expect(result).toEqual({ decisionId: null });
    expect(await decisions(f)).toMatchObject([{ _id: decisionId, state: "superseded" }]);
    await invariant(f);
  });
});
