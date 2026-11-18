import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  insertProviderDeal,
  insertProviderFact,
  insertProviderIdentifier,
  insertProviderPerson,
  PAYER_EMAIL,
  providerPaymentFixture,
  setPaymentFixtureModes,
  FIXTURE_PAID_AT,
} from "../../tests/providerPaymentFixtures";
import { assertPaymentInvariants, seedProviderWin } from "../../tests/paymentInvariants";
import {
  checkPaymentReconciliation,
  readReconciliationDealPayments,
  resolveReconciliation,
  type ReconcileConflict,
  type ReconcileWriter,
} from "./reconcileCheck";

const getPaymentReconciliation = makeFunctionReference<"query">("payments/reconcileCheck:getPaymentReconciliation");
type Fixture = Awaited<ReturnType<typeof providerPaymentFixture>>;

function check(f: Fixture, writer: ReconcileWriter = "meeting") {
  const opportunityId = f.dealId!;
  return f.t.run(async (ctx) => checkPaymentReconciliation(ctx, {
    tenantId: f.tenantId,
    leadId: f.personId,
    opportunityId,
    writer,
    dealPayments: await readReconciliationDealPayments(ctx, opportunityId),
  }));
}

describe("Whop payment reconciliation", () => {
  it("finds the person through an email before the matcher has written a candidate", async () => {
    const f = await providerPaymentFixture({ fact: { reviewState: "needs_person", totalMinor: 27415 } });
    await f.t.run((ctx) => setPaymentFixtureModes(ctx, f));
    expect(await check(f)).toMatchObject([{
      providerPaymentId: f.providerPaymentId, allocationRevision: 0, state: "unlinked",
      totalMinor: 27415, currency: "USD", paidAt: FIXTURE_PAID_AT,
    }]);
  });

  it("uses verified aliases and ignores a stale hint after the payer changes", async () => {
    const alias = "alias@example.test";
    const f = await providerPaymentFixture({ fact: { reviewState: "needs_person", payerEmail: alias } });
    await f.t.run(async (ctx) => {
      await setPaymentFixtureModes(ctx, f);
      await insertProviderIdentifier(ctx, f.tenantId, f.personId, "email", alias);
      await insertProviderFact(ctx, f.tenantId, f.connectionId, {
        externalPaymentId: "pay_stale_hint",
        reviewState: "needs_person",
        payerEmail: "different@example.test",
        candidateLeadId: f.personId,
      });
    });
    expect(await check(f)).toMatchObject([{ providerPaymentId: f.providerPaymentId, state: "unlinked" }]);
  });

  it("does not disclose or allocate an ambiguous email", async () => {
    const f = await providerPaymentFixture({ fact: { reviewState: "needs_person" } });
    await f.t.run(async (ctx) => {
      await setPaymentFixtureModes(ctx, f);
      await insertProviderPerson(ctx, f.tenantId);
      await ctx.db.patch("providerPayments", f.providerPaymentId, { candidateLeadId: f.personId });
    });
    expect(await check(f)).toEqual([]);
  });

  it.each([
    { winMode: "off" as const },
    { winMode: "shadow" as const },
    { enabled: false },
    { pausedAt: 0 },
  ])("skips unlinked facts when ask is off by %j", async (settings) => {
    const f = await providerPaymentFixture({ fact: { reviewState: "needs_person" } });
    expect(await check(f)).toEqual([]);
    await f.t.run((ctx) => setPaymentFixtureModes(ctx, { ...f, ...settings }));
    expect(await check(f)).toEqual([]);
  });

  it("uses the mode of the writer's own kind", async () => {
    const f = await providerPaymentFixture({ fact: { reviewState: "needs_person" } });
    await f.t.run((ctx) => setPaymentFixtureModes(ctx, { ...f, additionalMode: "off" }));
    expect(await check(f, "side_deal")).toHaveLength(1);
    expect(await check(f, "additional")).toEqual([]);
  });

  it("requires acknowledgement before accepting an overflowing payer range", async () => {
    const f = await providerPaymentFixture({ fact: { reviewState: "needs_person" } });
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 20; i++) {
        await insertProviderFact(ctx, f.tenantId, f.connectionId, {
          externalPaymentId: `pay_overflow_${i}`, reviewState: "needs_person",
        });
      }
    });
    expect(await check(f)).toEqual([]);
    await f.t.run((ctx) => setPaymentFixtureModes(ctx, f));
    const conflicts = await check(f);
    expect(conflicts).toMatchObject([{ state: "read_limit" }]);
    expect(() => resolveReconciliation(conflicts, { kind: "different_money", pins: [] }))
      .toThrow("couldn't check all Whop payments");
    expect(resolveReconciliation(conflicts, { kind: "different_money", pins: [], acknowledgeReadLimit: true }))
      .toEqual({ action: "insert", distinctFrom: [] });
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("requires all known pins even when a read limit is acknowledged", async () => {
    const f = await providerPaymentFixture();
    const overflowId = await f.t.run((ctx) => insertProviderFact(ctx, f.tenantId, f.connectionId, {
      externalPaymentId: "pay_overflow",
    }));
    const pin = { providerPaymentId: f.providerPaymentId, allocationRevision: 0 };
    const overflowPin = { providerPaymentId: overflowId, allocationRevision: 0 };
    const conflicts: ReconcileConflict[] = [
      { ...pin, state: "unlinked", currency: "USD" },
      { ...overflowPin, state: "read_limit" },
    ];
    for (const pins of [[], [{ ...pin, allocationRevision: 1 }], [pin, overflowPin]]) {
      expect(() => resolveReconciliation(conflicts, { kind: "different_money", pins, acknowledgeReadLimit: true }))
        .toThrow("couldn't check all Whop payments");
    }
    expect(() => resolveReconciliation(conflicts, { kind: "different_money", pins: [pin], acknowledgeReadLimit: false }))
      .toThrow("couldn't check all Whop payments");
    expect(resolveReconciliation(conflicts, { kind: "different_money", pins: [pin], acknowledgeReadLimit: true }))
      .toEqual({ action: "insert", distinctFrom: [f.providerPaymentId] });

    const selected = { providerPaymentId: f.providerPaymentId, expectedAllocationRevision: 0 };
    expect(() => resolveReconciliation(conflicts, {
      kind: "same_money", ...selected, acknowledgeAmountDifference: false,
    })).toThrow("couldn't check all Whop payments");
    expect(() => resolveReconciliation(conflicts, { kind: "confirm", ...selected }))
      .toThrow("couldn't check all Whop payments");
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("still surfaces provider cash on another deal when ask is off", async () => {
    const f = await providerPaymentFixture({ fact: { payerEmail: undefined } });
    const paymentRecordId = await f.t.run(async (ctx) => {
      const opportunityId = await insertProviderDeal(ctx, {
        tenantId: f.tenantId, leadId: f.personId, assignedCloserId: f.closerId,
      });
      return await seedProviderWin(ctx, { ...f, opportunityId, approverId: f.adminId, recordedAt: FIXTURE_PAID_AT });
    });
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    const conflicts = await check(f);
    expect(conflicts).toMatchObject([{
      providerPaymentId: f.providerPaymentId, allocationRevision: 1, state: "recorded_elsewhere",
      recordedPaymentRecordId: paymentRecordId,
    }]);
    expect(() => resolveReconciliation(conflicts, {
      kind: "same_money", providerPaymentId: f.providerPaymentId, expectedAllocationRevision: 1,
      acknowledgeAmountDifference: true,
    })).toThrow("Review the Whop payment");
  });

  it("authorizes the same closer as the side-deal writer and returns the configured prefill", async () => {
    const f = await providerPaymentFixture({ source: "side_deal", fact: { reviewState: "needs_person" } });
    const other = f.t.withIdentity({ subject: "user_other", org_id: "org_test" });
    await f.t.run(async (ctx) => {
      await setPaymentFixtureModes(ctx, f);
      await ctx.db.insert("users", {
        tenantId: f.tenantId, workosUserId: "user_other", email: "other@example.test", role: "closer", isActive: true,
      });
    });
    const args = { target: { kind: "deal", opportunityId: f.dealId! } };
    await expect(f.t.query(getPaymentReconciliation, args)).rejects.toThrow();
    await expect(other.query(getPaymentReconciliation, args)).rejects.toThrow("not the assigned closer");
    const result = await f.closer.query(getPaymentReconciliation, args);
    expect(result).toMatchObject({
      conflicts: [{
        state: "unlinked",
        productTitle: "Sales training",
        variantTitle: "Pay in full",
      }],
      prefill: [{ providerPaymentId: f.providerPaymentId, amount: 100, currency: "USD", programId: f.programId, paymentType: "pif" }],
    });
    expect(JSON.stringify(result)).not.toContain(PAYER_EMAIL);
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("requires exact pins once per conflict, independent of order", async () => {
    const f = await providerPaymentFixture();
    const anotherId = await f.t.run((ctx) => insertProviderFact(ctx, f.tenantId, f.connectionId, {
      externalPaymentId: "pay_second",
    }));
    const pins = [
      { providerPaymentId: f.providerPaymentId, allocationRevision: 0 },
      { providerPaymentId: anotherId, allocationRevision: 2 },
    ];
    const conflicts: ReconcileConflict[] = pins.map((pin) => ({ ...pin, state: "unlinked", currency: "USD" }));
    const reversed = [...pins].reverse();
    expect(resolveReconciliation(conflicts, { kind: "different_money", pins: reversed })).toEqual({
      action: "insert", distinctFrom: reversed.map((pin) => pin.providerPaymentId),
    });
    expect(() => resolveReconciliation(conflicts, {
      kind: "different_money", pins: [pins[0], pins[0]],
    })).toThrow("Review the Whop payment");
  });

  it("counts the selected payment toward the ten-pin limit", async () => {
    const f = await providerPaymentFixture();
    const otherPins = await f.t.run(async (ctx) => {
      const pins = [];
      for (let index = 0; index < 10; index++) {
        const providerPaymentId = await insertProviderFact(ctx, f.tenantId, f.connectionId, {
          externalPaymentId: `pay_other_${index}`,
        });
        pins.push({ providerPaymentId, allocationRevision: 0 });
      }
      return pins;
    });
    const conflicts: ReconcileConflict[] = [
      { providerPaymentId: f.providerPaymentId, allocationRevision: 0 },
      ...otherPins,
    ].map((pin) => ({ ...pin, state: "unlinked", currency: "USD" }));
    const selected = {
      kind: "same_money" as const, providerPaymentId: f.providerPaymentId,
      expectedAllocationRevision: 0, acknowledgeAmountDifference: false,
    };
    expect(resolveReconciliation(conflicts.slice(0, 10), { ...selected, otherPins: otherPins.slice(0, 9) }))
      .toMatchObject({ action: "insert_and_link", distinctFrom: otherPins.slice(0, 9).map((pin) => pin.providerPaymentId) });
    expect(() => resolveReconciliation(conflicts, { ...selected, otherPins })).toThrow("Review the Whop payment");
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("ignores a different-money pin when its row is disputed", async () => {
    const f = await providerPaymentFixture({ fact: { reviewState: "needs_person" } });
    await f.t.run(async (ctx) => {
      await setPaymentFixtureModes(ctx, f);
      await ctx.db.insert("paymentRecords", {
        tenantId: f.tenantId,
        opportunityId: f.dealId,
        status: "disputed",
        recordedAt: FIXTURE_PAID_AT,
        amountMinor: 10000,
        currency: "USD",
        origin: "closer_additional",
        recordedByUserId: f.closerId,
        attributedCloserId: f.closerId,
        programId: f.programId,
        programName: "Sales training",
        paymentType: "pif",
        distinctFromProviderPaymentIds: [f.providerPaymentId],
      });
    });
    expect(await check(f)).toHaveLength(1);
  });

  it("refuses a stale allocation revision", async () => {
    const f = await providerPaymentFixture({ fact: { reviewState: "needs_person", allocationRevision: 3 } });
    await f.t.run((ctx) => setPaymentFixtureModes(ctx, f));
    const conflicts = await check(f);
    const providerPaymentId: Id<"providerPayments"> = f.providerPaymentId;
    expect(() => resolveReconciliation(conflicts, {
      kind: "confirm", providerPaymentId, expectedAllocationRevision: 2,
    })).toThrow("Review the Whop payment");
  });
});
