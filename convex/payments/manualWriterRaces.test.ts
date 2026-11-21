import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { insertCloserMeeting, insertTask } from "../../tests/closerPipelineFixtures";
import { assertPaymentInvariants, seedProviderWin } from "../../tests/paymentInvariants";
import {
  FIXTURE_NOW,
  FIXTURE_PAID_AT,
  insertProviderBinding,
  insertProviderFact,
  PAYER_EMAIL,
  PRODUCT_ID,
  VARIANT_ID,
  providerPaymentFixture,
  setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";
import { storeProofFile } from "../../tests/proofFixtures";
import { insertMeetingAggregate } from "../reporting/writeHooks";
import type { ProviderIntent, ReconcileWriter } from "./reconcileCheck";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const WRITERS = ["meeting", "reminder", "side_deal", "additional"] as const;

async function writerFixture(
  writer: ReconcileWriter,
  options: { providerWin?: boolean; boundInstalment?: boolean } = {},
) {
  const membershipId = options.boundInstalment ? "mem_writer_fixture" : undefined;
  const f = await providerPaymentFixture({
    ...(writer === "side_deal" && { source: "side_deal" }),
    ...(writer === "reminder" && { dealPosition: "follow_up" }),
  });
  const opportunityId = f.dealId!;
  const { t, tenantId, closerId, programId } = f;
  const { meetingId, followUpId, firstPaymentId } = await t.run(async (ctx) => {
    let meetingId: Id<"meetings"> | undefined;
    let followUpId: Id<"followUps"> | undefined;
    let firstPaymentId: Id<"paymentRecords"> | undefined;
    if (writer === "meeting" || writer === "additional") {
      meetingId = await insertCloserMeeting(ctx, {
        tenantId, opportunityId, closerId, status: "scheduled", scheduledAt: FIXTURE_NOW - 1_800_000,
      });
      await insertMeetingAggregate(ctx, meetingId);
    }
    if (writer === "reminder") {
      followUpId = await insertTask(ctx, {
        opportunityId, type: "manual_reminder", reason: "closer_initiated",
        status: "pending", reminderScheduledAt: FIXTURE_NOW - 60_000,
      });
    }
    if (options.providerWin) {
      if (membershipId) await ctx.db.patch("providerPayments", f.providerPaymentId, { membershipId });
      firstPaymentId = await seedProviderWin(ctx, {
        ...f, opportunityId, approverId: f.adminId, recordedAt: FIXTURE_PAID_AT,
      });
    }
    return { meetingId, followUpId, firstPaymentId };
  });
  const common = { amount: 100, currency: "USD", paymentType: "pif" as const };
  let anchorPaymentRecordId = firstPaymentId;
  if (writer === "additional" && !firstPaymentId) {
    anchorPaymentRecordId = await f.admin.mutation(api.closer.payments.logPayment, {
      ...common, amount: 200, opportunityId, meetingId: meetingId!, programId,
    });
  }
  if (membershipId && anchorPaymentRecordId) {
    const anchorId = anchorPaymentRecordId;
    if (!firstPaymentId) {
      const providerPaymentId = await t.run(async (ctx) => {
        await ctx.db.patch("providerPayments", f.providerPaymentId, { membershipId, billingReason: "subscription_cycle" });
        return insertProviderFact(ctx, tenantId, f.connectionId, {
          externalPaymentId: "pay_writer_anchor", membershipId, totalMinor: 20000,
        });
      });
      await f.admin.mutation(api.payments.review.linkToPaymentRecord, {
        providerPaymentId, paymentRecordId: anchorId, expectedAllocationRevision: 0,
      });
    }
    await t.run((ctx) => insertProviderBinding(ctx, {
      ...f, externalId: membershipId,
      binding: { kind: "membership_deal", opportunityId, leadId: f.personId, anchorPaymentRecordId: anchorId },
    }));
  }
  const save = (opts: { provider?: ProviderIntent; proofFileId?: Id<"_storage"> } = {}) => {
    switch (writer) {
      case "meeting":
        return f.closer.mutation(api.closer.payments.logPayment, {
          ...common, ...opts, opportunityId, meetingId: meetingId!, programId,
        });
      case "reminder":
        return f.closer.mutation(api.closer.reminderOutcomes.logReminderPayment, {
          ...common, ...opts, followUpId: followUpId!, programId,
        });
      case "side_deal":
        return f.closer.mutation(api.sideDeals.logPayment.logPayment, {
          ...common, ...opts, opportunityId, programId,
        });
      case "additional":
        return f.closer.mutation(api.closer.additionalPayment.recordAdditionalPayment, {
          ...common, ...opts, opportunityId,
        });
    }
  };
  const state = () => t.run(async (ctx) => ({
    deal: await ctx.db.get("opportunities", opportunityId),
    rows: await ctx.db.query("paymentRecords")
      .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", opportunityId)).take(41),
    meeting: meetingId ? await ctx.db.get("meetings", meetingId) : null,
    task: followUpId ? await ctx.db.get("followUps", followUpId) : null,
    fact: await ctx.db.get("providerPayments", f.providerPaymentId),
    events: await ctx.db.query("domainEvents").withIndex("by_tenantId_and_occurredAt", (q) =>
      q.eq("tenantId", tenantId)).take(40),
  }));
  const invariant = () => assertPaymentInvariants(t, { tenantId });
  return { ...f, opportunityId, meetingId, firstPaymentId, membershipId, save, state, invariant };
}

type Fixture = Awaited<ReturnType<typeof writerFixture>>;

async function storeWhopPayment(f: Fixture) {
  expect(await f.t.mutation(internal.payments.intake.storePaymentRead, {
    connectionId: f.connectionId,
    accountId: "biz_fixture",
    connectedAt: FIXTURE_NOW - 30 * 86_400_000,
    externalPaymentId: "pay_fixture",
    generation: 1,
    payment: {
      externalPaymentId: "pay_fixture",
      status: "paid",
      sourceCreatedAt: FIXTURE_PAID_AT,
      sourceUpdatedAt: FIXTURE_PAID_AT + 1_000,
      paidAt: FIXTURE_PAID_AT,
      totalMinor: 10000,
      currency: "USD",
      decimals: 2,
      refundedMinor: 0,
      adverseState: "none",
      billingReason: f.membershipId ? "subscription_cycle" : "one_time",
      membershipId: f.membershipId,
      productId: PRODUCT_ID,
      variantId: VARIANT_ID,
      lineItemCount: 1,
      failedAttemptCount: 0,
      payerEmail: PAYER_EMAIL,
    },
  })).toBe("stored");
}

function sameMoney(providerPaymentId: Id<"providerPayments">, expectedAllocationRevision: number):
  Extract<ProviderIntent, { kind: "same_money" }> {
  return { kind: "same_money", providerPaymentId, expectedAllocationRevision, acknowledgeAmountDifference: false };
}

const whopConflict = "payment.whop_payment_found";

function addConflict(f: Fixture, externalPaymentId: string) {
  return f.t.run((ctx) => insertProviderFact(ctx, f.tenantId, f.connectionId, {
    externalPaymentId, reviewState: "needs_person", membershipId: f.membershipId,
    billingReason: f.membershipId ? "subscription_cycle" : "one_time",
  }));
}

function selectPayment(f: Fixture, kind: "same_money" | "confirm") {
  return kind === "same_money"
    ? sameMoney(f.providerPaymentId, 0)
    : { kind, providerPaymentId: f.providerPaymentId, expectedAllocationRevision: 0 };
}

describe.each(WRITERS)("%s payment writer", (writer) => {
  it("uses the live match when the Whop read commits first", async () => {
    const f = await writerFixture(writer, { boundInstalment: writer === "additional" });
    await f.t.run((ctx) => setPaymentFixtureModes(ctx, f));
    await f.invariant();
    await storeWhopPayment(f);
    await f.invariant();

    const before = await f.state();
    if (writer === "side_deal") {
      await expect(f.save({ provider: sameMoney(f.providerPaymentId, 0) }))
        .rejects.toMatchObject({ data: { code: "payment.stale_preview" } });
      expect(await f.state()).toEqual(before);
      await f.save({ proofFileId: await storeProofFile(f.t) });
      const after = await f.state();
      expect(after.rows).toHaveLength(before.rows.length + 1);
      expect(after.fact).toMatchObject({ reviewState: "needs_person", allocationRevision: 0 });
      expect(after.deal?.humanResultRevision).toBe((before.deal?.humanResultRevision ?? 0) + 1);
      await f.invariant();
      return;
    }
    await expect(f.save()).rejects.toMatchObject({ data: {
      code: whopConflict,
      conflicts: [expect.objectContaining({ providerPaymentId: f.providerPaymentId, state: "unlinked" })],
    } });
    expect(await f.state()).toEqual(before);
    await f.invariant();

    await f.save({ provider: sameMoney(f.providerPaymentId, 0) });
    const after = await f.state();
    expect(after.rows).toHaveLength(before.rows.length + 1);
    expect(after.fact).toMatchObject({ reviewState: "linked", allocationRevision: 1 });
    expect(after.deal?.humanResultRevision).toBe((before.deal?.humanResultRevision ?? 0) + 1);
    await f.invariant();
  });

  it.each(["same_money", "confirm"] as const)("validates the other pins with %s", async (kind) => {
    const f = await writerFixture(writer, { boundInstalment: writer === "additional" });
    await f.t.run(async (ctx) => {
      await setPaymentFixtureModes(ctx, f);
      await ctx.db.patch("providerPayments", f.providerPaymentId, { reviewState: "needs_person" });
    });
    const otherId = await addConflict(f, "pay_other");
    const before = await f.state();
    const provider = {
      ...selectPayment(f, kind),
      otherPins: [{ providerPaymentId: otherId, allocationRevision: 0 }],
    };
    if (writer === "side_deal") {
      await expect(f.save({ provider })).rejects.toMatchObject({ data: { code: "payment.stale_preview" } });
      expect(await f.state()).toEqual(before);
      await f.invariant();
      return;
    }
    await f.save({ provider });
    const after = await f.state();
    expect(after.rows).toHaveLength(before.rows.length + 1);
    expect(after.rows).toContainEqual(expect.objectContaining({
      providerPaymentId: f.providerPaymentId,
      distinctFromProviderPaymentIds: [otherId],
    }));
    expect(after.fact).toMatchObject({ reviewState: kind === "confirm" ? "recorded" : "linked" });
    expect(await f.t.run((ctx) => ctx.db.get("providerPayments", otherId))).toMatchObject({
      reviewState: "needs_person", allocationRevision: 0,
    });
    const reconciliation = await f.closer.query(api.payments.reconcileCheck.getPaymentReconciliation, {
      target: { kind: "deal", opportunityId: f.opportunityId },
    });
    expect(reconciliation.conflicts.map((conflict) => conflict.providerPaymentId))
      .toEqual(kind === "confirm" ? [f.providerPaymentId] : []);
    await f.invariant();

    if (writer === "additional" && kind === "same_money") {
      await f.save({ proofFileId: await storeProofFile(f.t) });
      expect((await f.state()).rows).toHaveLength(before.rows.length + 2);
      await f.invariant();
    }
  });

  it("leaves the Whop fact unallocated when the manual save commits first", async () => {
    const f = await writerFixture(writer);
    await f.t.run((ctx) => setPaymentFixtureModes(ctx, f));
    await f.invariant();
    const before = await f.state();
    await f.save({ proofFileId: await storeProofFile(f.t) });
    const afterManual = await f.state();
    expect(afterManual.rows).toHaveLength(before.rows.length + 1);
    expect(afterManual.deal?.humanResultRevision).toBe((before.deal?.humanResultRevision ?? 0) + 1);
    await f.invariant();

    await storeWhopPayment(f);
    const afterWhop = await f.state();
    expect(afterWhop.rows).toEqual(afterManual.rows);
    expect(afterWhop.fact).toMatchObject({ reviewState: "needs_person", allocationRevision: 0 });
    expect(afterWhop.fact?.paymentRecordId).toBeUndefined();
    await f.invariant();
  });

  it.each([39, 40])("enforces capacity with %i stored rows, including disputed rows", async (count) => {
    const f = await writerFixture(writer);
    await f.t.run(async (ctx) => {
      for (let n = writer === "additional" ? 1 : 0; n < count; n++) {
        await ctx.db.insert("paymentRecords", {
          tenantId: f.tenantId,
          opportunityId: f.opportunityId,
          attributedCloserId: f.closerId,
          recordedByUserId: f.closerId,
          programId: f.programId,
          programName: "Sales training",
          amountMinor: 1,
          currency: "USD",
          status: "disputed",
          paymentType: "split",
          recordedAt: FIXTURE_PAID_AT,
          origin: "closer_additional",
        });
      }
    });
    await f.invariant();
    const before = await f.state();
    expect(before.rows).toHaveLength(count);
    const proofFileId = await storeProofFile(f.t);
    if (count === 39) {
      await f.save({ proofFileId });
      const after = await f.state();
      expect(after.rows).toHaveLength(40);
      expect(after.deal?.humanResultRevision).toBe((before.deal?.humanResultRevision ?? 0) + 1);
    } else {
      await expect(f.save({ proofFileId })).rejects.toMatchObject({ data: { code: "payment.capacity_hold" } });
      expect(await f.state()).toEqual(before);
    }
    await f.invariant();
  });
});

it.each(["same_money", "confirm"] as const)("rejects invalid or out-of-date other pins with %s", async (kind) => {
  const f = await writerFixture("additional", { boundInstalment: true });
  await f.t.run(async (ctx) => {
    await setPaymentFixtureModes(ctx, f);
    await ctx.db.patch("providerPayments", f.providerPaymentId, { reviewState: "needs_person" });
  });
  const otherId = await addConflict(f, "pay_other");
  const pin = { providerPaymentId: otherId, allocationRevision: 0 };
  const extraId = await f.t.run((ctx) => insertProviderFact(ctx, f.tenantId, f.connectionId, {
    externalPaymentId: "pay_outside_conflicts",
  }));
  const extraPin = { providerPaymentId: extraId, allocationRevision: 0 };
  const selected = selectPayment(f, kind);
  const before = await f.state();
  for (const otherPins of [undefined, [pin, extraPin], [{ ...pin, allocationRevision: 1 }]]) {
    await expect(f.save({ provider: { ...selected, otherPins } }))
      .rejects.toMatchObject({ data: { code: whopConflict } });
    expect(await f.state()).toEqual(before);
    await f.invariant();
  }

  const shown = await f.closer.query(api.payments.reconcileCheck.getPaymentReconciliation, {
    target: { kind: "deal", opportunityId: f.opportunityId },
  });
  expect(shown.conflicts.map((conflict) => conflict.providerPaymentId))
    .toEqual([f.providerPaymentId, otherId]);
  const arrivedId = await addConflict(f, "pay_arrived");
  await expect(f.save({ provider: { ...selected, otherPins: [pin] } }))
    .rejects.toMatchObject({ data: {
      code: whopConflict,
      conflicts: expect.arrayContaining([expect.objectContaining({ providerPaymentId: arrivedId })]),
    } });
  expect(await f.state()).toEqual(before);
  await f.invariant();
});

it("saves with a read-limit acknowledgement and asks again on the next save", async () => {
  const f = await writerFixture("additional");
  await f.t.run(async (ctx) => {
    await setPaymentFixtureModes(ctx, f);
    for (let index = 0; index < 20; index++) {
      await insertProviderFact(ctx, f.tenantId, f.connectionId, {
        externalPaymentId: `pay_overflow_${index}`, reviewState: "needs_person",
      });
    }
  });
  const proofFileId = await storeProofFile(f.t);
  const before = await f.state();
  const provider = { kind: "different_money" as const, pins: [] };
  const readLimitError = { data: { code: whopConflict, conflicts: [{ state: "read_limit" }] } };
  await expect(f.save({ provider, proofFileId })).rejects.toMatchObject(readLimitError);
  expect(await f.state()).toEqual(before);
  await f.invariant();

  const result = await f.save({ provider: { ...provider, acknowledgeReadLimit: true }, proofFileId });
  if (typeof result === "string") throw new Error("Expected the additional-payment writer result");
  const row = await f.t.run((ctx) => ctx.db.get("paymentRecords", result.paymentId));
  expect(row).toMatchObject({ proofFileId, origin: "closer_additional" });
  expect(row?.distinctFromProviderPaymentIds).toBeUndefined();
  const after = await f.state();
  expect(after.rows).toHaveLength(before.rows.length + 1);
  await f.invariant();

  await expect(f.save()).rejects.toMatchObject(readLimitError);
  expect(await f.state()).toEqual(after);
  await f.invariant();
});

it.each([1, 10])("attaches to an existing payment with %i previously saved distinct payments", async (priorCount) => {
  const f = await writerFixture("additional", { providerWin: true, boundInstalment: true });
  const priorIds = await f.t.run(async (ctx) => {
    await setPaymentFixtureModes(ctx, f);
    const ids = [];
    for (let index = 0; index < priorCount; index++) {
      ids.push(await insertProviderFact(ctx, f.tenantId, f.connectionId, {
        externalPaymentId: `pay_prior_${index}`,
      }));
    }
    await ctx.db.patch("paymentRecords", f.firstPaymentId!, {
      distinctFromProviderPaymentIds: priorCount === 1 ? [ids[0], ids[0]] : ids,
    });
    return ids;
  });
  const otherId = await addConflict(f, "pay_other");
  const before = await f.state();
  const provider = {
    ...sameMoney(f.providerPaymentId, 1),
    otherPins: [{ providerPaymentId: otherId, allocationRevision: 0 }],
  };
  if (priorCount === 10) {
    await expect(f.save({ provider })).rejects.toMatchObject({ data: { code: whopConflict } });
    expect(await f.state()).toEqual(before);
  } else {
    expect(await f.save({ provider })).toEqual({ paymentId: f.firstPaymentId });
    expect((await f.state()).rows).toEqual([{
      ...before.rows[0],
      distinctFromProviderPaymentIds: [...priorIds, otherId],
    }]);
  }
  await f.invariant();
});

it("attaches proof and marks attendance when Whop won before the meeting writer could save", async () => {
  const f = await writerFixture("meeting", { providerWin: true });
  await f.invariant();
  const before = await f.state();
  await expect(f.save()).rejects.toMatchObject({ data: {
    code: whopConflict,
    conflicts: [expect.objectContaining({ state: "recorded_here", recordedPaymentRecordId: f.firstPaymentId })],
  } });
  expect(await f.state()).toEqual(before);
  await f.invariant();

  const proofFileId = await storeProofFile(f.t);
  const args = { proofFileId, provider: sameMoney(f.providerPaymentId, 1) };
  expect(await f.save(args)).toBe(f.firstPaymentId);
  const after = await f.state();
  expect(after.rows).toHaveLength(1);
  expect(after.rows[0]).toMatchObject({ proofFileId, amountMinor: 10000, origin: "provider" });
  expect(after.meeting).toMatchObject({ status: "held", heldMarkedAt: FIXTURE_NOW });
  expect(after.deal?.humanResultRevision).toBe(1);
  expect(after.deal?.paymentReceivedAt).toBe(FIXTURE_PAID_AT);
  await f.invariant();

  expect(await f.save(args)).toBe(f.firstPaymentId);
  expect(await f.state()).toEqual(after);
  await f.invariant();
});

it("records equal but distinct instalments without asking again about the pinned Whop payment", async () => {
  const f = await writerFixture("additional", { providerWin: true });
  await f.invariant();
  await expect(f.save()).rejects.toMatchObject({ data: { code: whopConflict } });
  await f.invariant();
  const proofFileId = await storeProofFile(f.t);
  const pin = { providerPaymentId: f.providerPaymentId, allocationRevision: 1 };
  await expect(f.save({
    proofFileId, provider: { kind: "different_money", pins: [{ ...pin, allocationRevision: 0 }] },
  })).rejects.toMatchObject({ data: { code: whopConflict } });
  await f.invariant();
  const linked = await f.save({ proofFileId, provider: { kind: "different_money", pins: [pin] } });
  let state = await f.state();
  expect(state.rows).toHaveLength(2);
  expect(state.rows[1]).toMatchObject({ amountMinor: 10000, distinctFromProviderPaymentIds: [f.providerPaymentId] });
  expect(linked).toEqual({ paymentId: state.rows[1]._id });
  await f.invariant();

  await f.save({ proofFileId: await storeProofFile(f.t) });
  state = await f.state();
  expect(state.rows).toHaveLength(3);
  expect(state.deal?.humanResultRevision).toBe(2);
  expect(state.fact?.paymentRecordId).toBe(f.firstPaymentId);
  await f.invariant();
});

it("rejects the old different-money pins when a second Whop payment appears", async () => {
  const f = await writerFixture("additional", { providerWin: true, boundInstalment: true });
  await f.t.run((ctx) => setPaymentFixtureModes(ctx, f));
  await addConflict(f, "pay_new");
  await f.invariant();
  await expect(f.save({ provider: { kind: "different_money", pins: [
    { providerPaymentId: f.providerPaymentId, allocationRevision: 1 },
  ] } })).rejects.toMatchObject({ data: {
    code: whopConflict,
    conflicts: [expect.objectContaining({ state: "recorded_here" }), expect.objectContaining({ state: "unlinked" })],
  } });
  await f.invariant();
});
