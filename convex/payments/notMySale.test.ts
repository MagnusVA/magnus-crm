import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertPaymentInvariants, seedProviderWin } from "../../tests/paymentInvariants";
import { FIXTURE_NOW, paymentConfirmationApi, paymentConfirmationFixture } from "../../tests/providerPaymentFixtures";
import { api } from "../_generated/api";

const { flagNotMySale, clearNotMySale } = paymentConfirmationApi.payments.notMySale;
const list = api.payments.review.listProviderExceptions;
const counts = api.payments.review.getProviderExceptionCounts;

async function clearArgsFor(f: Awaited<ReturnType<typeof paymentConfirmationFixture>>) {
  const providerPaymentId = f.providerPaymentId;
  const pin = await f.admin.query(api.payments.notMySale.getClearNotMySalePin, { providerPaymentId });
  if (!pin) throw new Error("Expected an active flag");
  return {
    providerPaymentId,
    expectedFlagGeneration: pin.expectedFlagGeneration,
    expectedAllocationRevision: pin.expectedAllocationRevision,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("accepts the assigned or credited closer, shows the flag in Billing, and flags and clears idempotently", async () => {
  const f = await paymentConfirmationFixture();
  const invariant = () => assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  const paymentRecordId = await f.t.run((ctx) => seedProviderWin(ctx, {
    ...f, opportunityId: f.dealId, recordedAt: FIXTURE_NOW - 60_000, approverId: f.adminId,
  }));
  await invariant();
  const assignedId = await f.t.run(async (ctx) => {
    const addCloser = (name: string) => ctx.db.insert("users", {
      tenantId: f.tenantId, workosUserId: name, email: `${name}@example.com`, role: "closer", isActive: true,
    });
    const assigned = await addCloser("user_assigned");
    await addCloser("user_unrelated");
    await ctx.db.patch("opportunities", f.dealId, { assignedCloserId: assigned });
    return assigned;
  });
  const assigned = f.t.withIdentity({ subject: "user_assigned", org_id: "org_test" });
  const unrelated = f.t.withIdentity({ subject: "user_unrelated", org_id: "org_test" });
  await invariant();

  await expect(unrelated.mutation(flagNotMySale, { paymentRecordId })).rejects.toThrow("another closer");
  await invariant();
  expect(await f.closer.mutation(flagNotMySale, { paymentRecordId })).toEqual({ ok: true, alreadyApplied: false });
  await invariant();
  expect(await assigned.mutation(flagNotMySale, { paymentRecordId })).toEqual({ ok: true, alreadyApplied: true });
  await invariant();
  const queueArgs = { state: "not_my_sale" as const, paginationOpts: { cursor: null, numItems: 10 } };
  expect((await f.admin.query(list, queueArgs)).page).toMatchObject([{
    providerPaymentId: f.providerPaymentId, notMySaleAt: FIXTURE_NOW, waitsOn: "billing", ageMs: 0,
  }]);
  expect(await f.admin.query(counts, {})).toMatchObject({ notMySaleCount: 1, notMySaleCapped: false });

  const clearArgs = await clearArgsFor(f);
  await expect(assigned.mutation(clearNotMySale, clearArgs)).rejects.toThrow();
  await invariant();
  expect(await f.admin.mutation(clearNotMySale, clearArgs)).toEqual({ ok: true, alreadyApplied: false });
  await invariant();
  expect(await f.admin.mutation(clearNotMySale, clearArgs)).toEqual({ ok: true, alreadyApplied: true });
  await invariant();
  expect((await f.admin.query(list, queueArgs)).page).toHaveLength(0);
  expect(await f.admin.query(counts, {})).toMatchObject({ notMySaleCount: 0 });
  expect(await assigned.mutation(flagNotMySale, { paymentRecordId })).toEqual({ ok: true, alreadyApplied: false });
  await invariant();
  const events = await f.t.run((ctx) => ctx.db.query("domainEvents")
    .withIndex("by_tenantId_and_eventType_and_occurredAt", (q) =>
      q.eq("tenantId", f.tenantId).eq("eventType", "payment.flagged_not_my_sale")).take(4));
  expect(events.map((event) => event.actorUserId)).toEqual([f.closerId, assignedId]);
});

it("refuses a delayed acknowledgement after the closer flags the same payment again", async () => {
  const f = await paymentConfirmationFixture();
  const paymentRecordId = await f.t.run((ctx) => seedProviderWin(ctx, {
    ...f, opportunityId: f.dealId, recordedAt: FIXTURE_NOW - 60_000, approverId: f.adminId,
  }));
  expect(await f.closer.mutation(flagNotMySale, { paymentRecordId })).toMatchObject({ ok: true, alreadyApplied: false });
  const shown = await clearArgsFor(f);
  const acknowledge = () => f.admin.mutation(clearNotMySale, shown);
  expect(await acknowledge()).toEqual({ ok: true, alreadyApplied: false });
  expect(await acknowledge()).toEqual({ ok: true, alreadyApplied: true });
  expect(await f.closer.mutation(flagNotMySale, { paymentRecordId })).toMatchObject({ ok: true, alreadyApplied: false });
  expect(await acknowledge()).toEqual({ ok: false, code: "stale_preview" });
  const latest = await clearArgsFor(f);
  expect(latest.expectedFlagGeneration).toBe(shown.expectedFlagGeneration + 1);
  expect(await f.admin.mutation(clearNotMySale, {
    ...latest, expectedAllocationRevision: latest.expectedAllocationRevision - 1,
  })).toEqual({ ok: false, code: "reallocated" });
  expect(await f.t.run((ctx) => ctx.db.get("providerPayments", f.providerPaymentId)))
    .toMatchObject({ notMySaleAt: FIXTURE_NOW, notMySaleByUserId: f.closerId });
  await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
});
