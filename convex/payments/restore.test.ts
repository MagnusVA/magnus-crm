import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { insertProgram } from "../../tests/enrollmentFixtures";
import { assertPaymentInvariants, seedProviderWin } from "../../tests/paymentInvariants";
import { storeProofFile } from "../../tests/proofFixtures";
import {
  FIXTURE_NOW,
  confirmAttendedWhopWin,
  insertProviderDeal,
  insertProviderMeeting,
  insertProviderPerson,
  providerPaymentFixture,
  seedBillingWin,
  seedManualPayment,
} from "../../tests/providerPaymentFixtures";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import { moveCallbackCore } from "../mcp/tools/callbacks";
import type { ExcludeArgs } from "./exclude";

// Restoring an exclusion made in error (build contract §2.6, plan §2.14
// "Restore", §12): invariants after every step.

const WIN_AT = FIXTURE_NOW - 10_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

type Fixture = Awaited<ReturnType<typeof providerPaymentFixture>>;
type Caller = Fixture["admin"];

async function exclude(caller: Caller, args: Omit<ExcludeArgs, "expectedFingerprint" | "voidReason">) {
  const { fingerprint } = await caller.query(api.payments.exclude.previewExclusion, {
    paymentRecordId: args.paymentRecordId, cause: args.cause,
  });
  const result = await caller.mutation(api.payments.exclude.excludePayment, { ...args, expectedFingerprint: fingerprint });
  if (!result.ok) throw new Error(`exclusion refused: ${result.code}`);
  return result.correctionId;
}

async function previewRestore(caller: Caller, correctionId: Id<"paymentCorrections">) {
  return await caller.query(api.payments.restore.previewRestore, { correctionId });
}

async function restore(caller: Caller, correctionId: Id<"paymentCorrections">, expectedFingerprint?: string) {
  const fingerprint = expectedFingerprint ?? (await previewRestore(caller, correctionId)).fingerprint;
  return await caller.mutation(api.payments.restore.restorePayment, { correctionId, expectedFingerprint: fingerprint });
}

async function billingWin(f: Fixture, options: { meetingAt?: number } = {}) {
  return await f.t.run(async (ctx) => {
    const meetingId = options.meetingAt === undefined ? undefined : await insertProviderMeeting(ctx, {
      tenantId: f.tenantId, opportunityId: f.dealId!, closerId: f.closerId, scheduledAt: options.meetingAt,
    });
    const win = await seedBillingWin(ctx, {
      tenantId: f.tenantId, opportunityId: f.dealId!, providerPaymentId: f.providerPaymentId, programId: f.programId,
      closerId: f.closerId, approverId: f.adminId, recordedAt: WIN_AT,
    });
    return { ...win, meetingId };
  });
}

function snapshot(f: Fixture, paymentRecordId: Id<"paymentRecords">) {
  return f.t.run(async (ctx) => ({
    row: await ctx.db.get("paymentRecords", paymentRecordId),
    fact: await ctx.db.get("providerPayments", f.providerPaymentId),
    deal: await ctx.db.get("opportunities", f.dealId!),
    tasks: await ctx.db.query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) => q.eq("opportunityId", f.dealId!)).take(20),
    enrollments: await ctx.db.query("enrollments")
      .withIndex("by_tenantId_and_leadId_and_programId", (q) => q.eq("tenantId", f.tenantId).eq("leadId", f.personId)).take(10),
    corrections: await ctx.db.query("paymentCorrections")
      .withIndex("by_tenantId_and_opportunityId_and_createdAt", (q) => q.eq("tenantId", f.tenantId).eq("opportunityId", f.dealId!))
      .take(20),
    events: (await ctx.db.query("domainEvents")
      .withIndex("by_tenantId_and_occurredAt", (q) => q.eq("tenantId", f.tenantId)).take(1000)).length,
  }));
}

function eventCount(f: Fixture, eventType: string) {
  return f.t.run(async (ctx) => (await ctx.db.query("domainEvents")
    .withIndex("by_tenantId_and_eventType_and_occurredAt", (q) => q.eq("tenantId", f.tenantId).eq("eventType", eventType))
    .take(50)).length);
}

describe("restoring an exclusion made in error", () => {
  it("re-wins an attended win closed lost by mistake, and a retried restore writes nothing", async () => {
    const f = await providerPaymentFixture();
    const invariant = () => assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    const { paymentRecordId, meetingId } = await confirmAttendedWhopWin(f);
    const held = await f.t.run((ctx) => ctx.db.get("meetings", meetingId));
    await invariant();

    const correctionId = await exclude(f.admin, {
      paymentRecordId, cause: "wrong_match", level: "reviewed", disposition: "lost",
    });
    let state = await snapshot(f, paymentRecordId);
    expect(state.deal).toMatchObject({ outcome: "lost", lostReason: "payment_excluded", lostByUserId: f.adminId });
    expect(state.enrollments).toEqual([]);
    expect(state.fact?.excludedOpportunityIds).toEqual([f.dealId]);
    await invariant();

    const shown = await previewRestore(f.admin, correctionId);
    expect(shown).toMatchObject({
      result: "restored_won", move: "payment_exclusion_restored", newFirstPaymentAt: FIXTURE_NOW,
      cashDeltaByCurrency: [{ currency: "USD", amountMinor: 10000 }],
    });
    const recordedBefore = await eventCount(f, "payment.recorded");
    const result = await restore(f.admin, correctionId, shown.fingerprint);
    expect(result).toMatchObject({ ok: true, alreadyApplied: false });
    state = await snapshot(f, paymentRecordId);
    expect(state.row).toMatchObject({ status: "recorded", providerPaymentId: f.providerPaymentId });
    expect(state.fact).toMatchObject({ paymentRecordId, reviewState: "recorded", allocationRevision: 3 });
    expect(state.fact?.excludedOpportunityIds).toBeUndefined();
    expect(state.deal).toMatchObject({ stage: "closed", outcome: "won", paymentReceivedAt: FIXTURE_NOW });
    expect(state.deal?.lostReason).toBeUndefined();
    expect(state.deal?.lostAt).toBeUndefined();
    expect(state.deal?.lostByUserId).toBeUndefined();
    expect(state.enrollments).toMatchObject([{ programId: f.programId, enrolledAt: FIXTURE_NOW }]);
    expect(await f.t.run((ctx) => ctx.db.get("meetings", meetingId))).toMatchObject({ status: "held", heldMarkedAt: held!.heldMarkedAt });
    expect(state.corrections.map((row) => [row.operation, row.result])).toEqual([["exclude", "lost"], ["restore", "restored_won"]]);
    expect(state.corrections[0].restoredByCorrectionId).toBe(state.corrections[1]._id);
    expect(state.corrections[1].restoresCorrectionId).toBe(correctionId);
    expect(await eventCount(f, "payment.restored")).toBe(1);
    expect(await eventCount(f, "payment.recorded")).toBe(recordedBefore);
    await invariant();

    const retried = await restore(f.admin, correctionId, shown.fingerprint);
    expect(retried).toEqual({ ok: true, alreadyApplied: true, correctionId: state.corrections[1]._id });
    expect(await snapshot(f, paymentRecordId)).toEqual(state);
    await invariant();
  });

  it("re-wins a Follow-up correction and expires its untouched reminder; a worked reminder is stale", async () => {
    for (const worked of [false, true]) {
      const f = await providerPaymentFixture();
      const invariant = () => assertPaymentInvariants(f.t, { tenantId: f.tenantId });
      const { paymentRecordId } = await confirmAttendedWhopWin(f);
      const correctionId = await exclude(f.admin, {
        paymentRecordId, cause: "wrong_match", level: "reviewed", disposition: "follow_up", followUpContactMethod: "call",
      });
      const reminder = (await snapshot(f, paymentRecordId)).tasks.find((task) => task.status === "pending")!;
      await invariant();
      if (worked) {
        await f.t.run((ctx) => ctx.db.patch("followUps", reminder._id, { reminderScheduledAt: FIXTURE_NOW + 60_000 }));
        const before = await previewRestore(f.admin, correctionId);
        await f.t.run((ctx) => ctx.db.patch("followUps", reminder._id, { status: "completed", completedAt: FIXTURE_NOW }));
        const frozen = await snapshot(f, paymentRecordId);
        expect(await restore(f.admin, correctionId, before.fingerprint)).toEqual({ ok: false, code: "stale_preview" });
        expect(await snapshot(f, paymentRecordId)).toEqual(frozen);
        continue;
      }
      expect((await previewRestore(f.admin, correctionId)).move).toBe("ordinary");
      expect((await restore(f.admin, correctionId)).ok).toBe(true);
      const state = await snapshot(f, paymentRecordId);
      expect(state.deal).toMatchObject({ outcome: "won", paymentReceivedAt: FIXTURE_NOW });
      expect(state.tasks.find((task) => task._id === reminder._id)?.status).toBe("expired");
      expect(state.tasks.filter((task) => task.status === "pending")).toEqual([]);
      expect(state.corrections[1].tasks).toEqual([{ followUpId: reminder._id, change: "expired" }]);
      await invariant();
    }
  });

  it("refuses old and fresh restore previews after the closer moves the exclusion reminder", async () => {
    const f = await providerPaymentFixture();
    const { paymentRecordId } = await confirmAttendedWhopWin(f);
    const correctionId = await exclude(f.admin, {
      paymentRecordId, cause: "wrong_match", level: "reviewed", disposition: "follow_up", followUpContactMethod: "call",
    });
    const original = await previewRestore(f.admin, correctionId);
    expect(original.move).toBe("ordinary");
    const reminder = (await snapshot(f, paymentRecordId)).tasks.find((task) => task.status === "pending")!;
    const reminderScheduledAt = FIXTURE_NOW + 86_400_000;
    const rescheduled = await f.t.run((ctx) => moveCallbackCore(
      ctx, { tenantId: f.tenantId, userId: f.closerId },
      { followUpId: reminder._id, reminderScheduledAt }, { via: "mcp", agentClient: "unknown" },
    ));
    expect(rescheduled.moved).toBe(true);
    const frozen = await snapshot(f, paymentRecordId);
    expect(frozen.tasks.find((task) => task._id === reminder._id))
      .toMatchObject({ status: "pending", reminderScheduledAt });

    expect(await restore(f.admin, correctionId, original.fingerprint)).toEqual({ ok: false, code: "stale_preview" });
    const fresh = await previewRestore(f.admin, correctionId);
    expect.soft(fresh.refusal).toBe("stale_preview");
    expect(await restore(f.admin, correctionId, fresh.fingerprint)).toEqual({ ok: false, code: "stale_preview" });
    expect(await snapshot(f, paymentRecordId)).toEqual(frozen);
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("does not void a restored side-deal payment when the old void request is retried", async () => {
    const f = await providerPaymentFixture({ source: "side_deal" });
    const { paymentId } = await f.closer.mutation(api.sideDeals.logPayment.logPayment, {
      opportunityId: f.dealId!, amount: 100, currency: "USD", paymentType: "pif",
      programId: f.programId, proofFileId: await storeProofFile(f.t),
    });
    const args = { paymentId, reason: "Synthetic correction" };
    const version = async () => {
      const shown = await f.admin.query(api.sideDeals.voidPayment.getVoidStatusVersion, { paymentId });
      if (shown === null) throw new Error("Expected a voidable payment");
      return shown;
    };
    const originalVersion = await version();
    const oldRequest = { ...args, expectedStatusVersion: originalVersion };
    await f.admin.mutation(api.sideDeals.voidPayment.voidPayment, oldRequest);
    expect(await f.admin.mutation(api.sideDeals.voidPayment.voidPayment, oldRequest)).toBeNull();
    const excluded = await snapshot(f, paymentId);
    expect(excluded.row?.status).toBe("disputed");
    expect(excluded.corrections).toHaveLength(1);

    expect(await restore(f.admin, excluded.corrections[0]._id)).toMatchObject({ ok: true });
    const restored = await snapshot(f, paymentId);
    expect(restored.row?.status).toBe("recorded");
    expect(restored.deal?.outcome).toBe("won");

    expect(await f.admin.mutation(api.sideDeals.voidPayment.voidPayment, oldRequest)).toBeNull();
    await expect(f.admin.mutation(api.sideDeals.voidPayment.voidPayment, args))
      .rejects.toMatchObject({ data: { code: "payment.stale_preview" } });
    expect(await snapshot(f, paymentId)).toEqual(restored);
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });

    const restoredVersion = await version();
    expect(restoredVersion).not.toBe(originalVersion);
    await expect(f.admin.mutation(api.sideDeals.voidPayment.voidPayment, { ...args, expectedStatusVersion: "old version" }))
      .rejects.toMatchObject({ data: { code: "payment.stale_preview" } });
    await f.admin.mutation(api.sideDeals.voidPayment.voidPayment, { ...args, expectedStatusVersion: restoredVersion });
    expect((await snapshot(f, paymentId)).row?.status).toBe("disputed");
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("moves the first-payment time back when an older payment is restored while a later one survives", async () => {
    const f = await providerPaymentFixture({ fact: { reviewState: "needs_person" } });
    const invariant = () => assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    const { paymentRecordId } = await billingWin(f, { meetingAt: FIXTURE_NOW + 86_400_000 });
    const laterAt = FIXTURE_NOW - 5000;
    const { laterId, laterProgram } = await f.t.run(async (ctx) => {
      const laterProgram = await insertProgram(ctx, f.tenantId, "Later program");
      const laterId = await seedManualPayment(ctx, f, { opportunityId: f.dealId!, programId: laterProgram, recordedAt: laterAt });
      return { laterId, laterProgram };
    });
    await invariant();
    const correctionId = await exclude(f.admin, { paymentRecordId, cause: "refund", level: "reviewed" });
    let state = await snapshot(f, paymentRecordId);
    expect(state.deal).toMatchObject({ outcome: "won", paymentReceivedAt: laterAt, soldProgramId: laterProgram });
    expect(state.corrections[0].removedEnrollments).toEqual([{ programId: f.programId, status: "active" }]);
    await invariant();

    expect((await previewRestore(f.admin, correctionId))).toMatchObject({ result: "restored_kept_won", move: "none", newFirstPaymentAt: WIN_AT });
    expect((await restore(f.admin, correctionId)).ok).toBe(true);
    state = await snapshot(f, paymentRecordId);
    expect(state.deal).toMatchObject({ outcome: "won", paymentReceivedAt: WIN_AT, soldProgramId: laterProgram });
    expect(state.enrollments.map((row) => [row.programId, row.enrolledAt]).sort())
      .toEqual([[f.programId, WIN_AT], [laterProgram, laterAt]].sort());
    expect((await f.t.run((ctx) => ctx.db.get("paymentRecords", laterId)))?.status).toBe("recorded");
    await invariant();
  });

  it("refuses a stale approval after the closer closed the deal, and writes nothing", async () => {
    const f = await providerPaymentFixture();
    const { paymentRecordId } = await confirmAttendedWhopWin(f);
    const correctionId = await exclude(f.admin, {
      paymentRecordId, cause: "wrong_match", level: "reviewed", disposition: "follow_up", followUpContactMethod: "text",
    });
    const shown = await previewRestore(f.admin, correctionId);
    const reminder = (await snapshot(f, paymentRecordId)).tasks.find((task) => task.status === "pending")!;
    await f.closer.mutation(api.closer.reminderOutcomes.markReminderLost, { followUpId: reminder._id, reason: "budget" });
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    const frozen = await snapshot(f, paymentRecordId);
    expect(frozen.deal).toMatchObject({ outcome: "lost", lostReason: "budget" });
    expect(await restore(f.admin, correctionId, shown.fingerprint)).toEqual({ ok: false, code: "stale_preview" });
    expect((await previewRestore(f.admin, correctionId)).refusal).toBe("stale_preview");
    expect(await snapshot(f, paymentRecordId)).toEqual(frozen);
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("refuses to restore A once the Whop payment was re-matched to B", async () => {
    const f = await providerPaymentFixture({ fact: { reviewState: "needs_person" } });
    const invariant = () => assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    const { paymentRecordId } = await billingWin(f, { meetingAt: FIXTURE_NOW + 86_400_000 });
    const correctionId = await exclude(f.admin, { paymentRecordId, cause: "wrong_match", level: "undo" });
    const otherRow = await f.t.run(async (ctx) => {
      const otherPerson = await insertProviderPerson(ctx, f.tenantId, { fullName: "Sam Rivera", email: "sam@example.com" });
      const dealId = await insertProviderDeal(ctx, { tenantId: f.tenantId, leadId: otherPerson, assignedCloserId: f.closerId });
      return await seedProviderWin(ctx, {
        tenantId: f.tenantId, opportunityId: dealId, providerPaymentId: f.providerPaymentId, programId: f.programId,
        closerId: f.closerId, approverId: f.adminId, recordedAt: FIXTURE_NOW,
      });
    });
    await invariant();
    expect((await previewRestore(f.admin, correctionId)).refusal).toBe("reallocated");
    const frozen = await snapshot(f, paymentRecordId);
    expect(await restore(f.admin, correctionId)).toEqual({ ok: false, code: "reallocated" });
    expect(await snapshot(f, paymentRecordId)).toEqual(frozen);
    expect(frozen.row).toMatchObject({ status: "disputed", providerPaymentId: f.providerPaymentId });
    expect(frozen.fact?.paymentRecordId).toBe(otherRow);
    await invariant();
  });

  it("refuses while a refund or dispute is open, and allows a won dispute", async () => {
    const f = await providerPaymentFixture({ fact: { reviewState: "needs_person" } });
    const { paymentRecordId } = await billingWin(f, { meetingAt: FIXTURE_NOW + 86_400_000 });
    const correctionId = await exclude(f.admin, { paymentRecordId, cause: "chargeback", level: "undo" });
    for (const fields of [
      { adverseFencedAt: FIXTURE_NOW },
      { adverseState: "dispute_open" as const },
      { adverseState: "partially_refunded" as const, refundedMinor: 100 },
    ]) {
      await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, {
        adverseFencedAt: undefined, adverseState: "none", refundedMinor: 0, ...fields,
      }));
      expect(await restore(f.admin, correctionId)).toEqual({ ok: false, code: "adverse" });
    }
    await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, {
      adverseFencedAt: undefined, adverseState: "dispute_won", refundedMinor: 0,
    }));
    expect((await previewRestore(f.admin, correctionId)).move).toBe("ordinary");
    expect((await restore(f.admin, correctionId)).ok).toBe(true);
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("re-wins an undone system loss and a Calendly-canceled undo through provider_payment_after_system_loss", async () => {
    for (const setup of ["system_loss", "calendly_canceled"] as const) {
      const f = await providerPaymentFixture({
        dealPosition: setup === "system_loss" ? "lost" : "booked",
        lostReason: setup === "system_loss" ? "no_show" : undefined,
        fact: { reviewState: "needs_person" },
      });
      if (setup === "system_loss") {
        await f.t.run((ctx) => patchOpportunityLifecycle(ctx, f.dealId!, { lostAt: FIXTURE_NOW - 50_000 }));
      }
      const { paymentRecordId, meetingId } = await billingWin(f, {
        meetingAt: setup === "calendly_canceled" ? FIXTURE_NOW + 86_400_000 : undefined,
      });
      if (meetingId) {
        const { patchMeetingLifecycle } = await import("../lib/meetingLifecycle");
        await f.t.run((ctx) => patchMeetingLifecycle(ctx, meetingId, { status: "canceled", canceledAt: FIXTURE_NOW - 5000 }));
      }
      const correctionId = await exclude(f.admin, { paymentRecordId, cause: "wrong_match", level: "undo" });
      await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
      expect(await previewRestore(f.admin, correctionId)).toMatchObject({ move: "provider_payment_after_system_loss" });
      expect((await restore(f.admin, correctionId)).ok).toBe(true);
      const { deal } = await snapshot(f, paymentRecordId);
      expect(deal).toMatchObject({ outcome: "won", paymentReceivedAt: WIN_AT });
      expect(deal?.lostReason).toBeUndefined();
      await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    }
  });

  it("refuses a restore a later exclusion owns, until that one is restored", async () => {
    const f = await providerPaymentFixture({ fact: { reviewState: "needs_person" } });
    const invariant = () => assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    const { paymentRecordId } = await billingWin(f, { meetingAt: FIXTURE_NOW + 86_400_000 });
    const laterId = await f.t.run((ctx) => seedManualPayment(ctx, f, {
      opportunityId: f.dealId!, programId: f.programId, recordedAt: FIXTURE_NOW - 5000,
    }));
    const first = await exclude(f.admin, { paymentRecordId, cause: "refund", level: "reviewed" });
    const second = await exclude(f.admin, { paymentRecordId: laterId, cause: "refund", level: "reviewed", disposition: "lost" });
    await invariant();
    expect(await restore(f.admin, first)).toEqual({ ok: false, code: "closed_by_other_exclusion" });
    expect((await previewRestore(f.admin, second)).move).toBe("payment_exclusion_restored");
    expect((await restore(f.admin, second)).ok).toBe(true);
    await invariant();
    expect((await restore(f.admin, first)).ok).toBe(true);
    expect((await snapshot(f, paymentRecordId)).deal).toMatchObject({ outcome: "won", paymentReceivedAt: WIN_AT });
    await invariant();
  });

  it("refuses when an enrollment the exclusion removed had been paused", async () => {
    const f = await providerPaymentFixture({ fact: { reviewState: "needs_person" } });
    const { paymentRecordId } = await billingWin(f, { meetingAt: FIXTURE_NOW + 86_400_000 });
    await f.t.run(async (ctx) => {
      const [enrollment] = await ctx.db.query("enrollments")
        .withIndex("by_tenantId_and_leadId_and_programId", (q) => q.eq("tenantId", f.tenantId).eq("leadId", f.personId)).take(1);
      await ctx.db.patch("enrollments", enrollment._id, { status: "paused", statusChangedAt: FIXTURE_NOW - 1000 });
    });
    const correctionId = await exclude(f.admin, { paymentRecordId, cause: "refund", level: "undo" });
    expect(await restore(f.admin, correctionId)).toEqual({ ok: false, code: "enrollment_status_changed" });
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("needs billing:correct", async () => {
    const f = await providerPaymentFixture({ fact: { reviewState: "needs_person" } });
    const { paymentRecordId } = await billingWin(f);
    const correctionId = await exclude(f.admin, { paymentRecordId, cause: "refund", level: "undo" });
    await expect(previewRestore(f.closer, correctionId)).rejects.toThrow();
    await expect(f.closer.mutation(api.payments.restore.restorePayment, { correctionId, expectedFingerprint: "0".repeat(64) }))
      .rejects.toThrow();
  });
});

describe("the task a payment completed (plan §12)", () => {
  async function reminderPaid() {
    const f = await providerPaymentFixture({ dealPosition: "follow_up" });
    const invariant = () => assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    const taskId = await f.t.run((ctx) => ctx.db.insert("followUps", {
      tenantId: f.tenantId, opportunityId: f.dealId!, leadId: f.personId, closerId: f.closerId,
      type: "manual_reminder", contactMethod: "call", reminderScheduledAt: FIXTURE_NOW - 60_000,
      reason: "closer_initiated", status: "pending", createdAt: FIXTURE_NOW - 120_000, createdSource: "closer",
      createdByUserId: f.closerId,
    }));
    const first = await f.closer.mutation(api.closer.reminderOutcomes.logReminderPayment, {
      followUpId: taskId, amount: 100, currency: "USD", programId: f.programId, paymentType: "deposit",
      proofFileId: await storeProofFile(f.t),
    });
    vi.setSystemTime(FIXTURE_NOW + 1000);
    const { paymentId: second } = await f.closer.mutation(api.closer.additionalPayment.recordAdditionalPayment, {
      opportunityId: f.dealId!, amount: 50, currency: "USD", paymentType: "split", proofFileId: await storeProofFile(f.t),
    });
    await invariant();
    expect(await f.t.run((ctx) => ctx.db.get("followUps", taskId))).toMatchObject({ status: "completed", completionPaymentId: first });
    return { f, invariant, taskId, first, second };
  }

  it("keeps the task completed by a surviving payment, reopens it once, and completes it again on restore", async () => {
    const { f, invariant, taskId, first, second } = await reminderPaid();
    await exclude(f.admin, { paymentRecordId: first, cause: "refund", level: "reviewed" });
    expect(await f.t.run((ctx) => ctx.db.get("followUps", taskId))).toMatchObject({ status: "completed", completionPaymentId: second });
    await invariant();

    const correctionId = await exclude(f.admin, {
      paymentRecordId: second, cause: "refund", level: "reviewed", disposition: "follow_up", followUpContactMethod: "text",
    });
    let state = await snapshot(f, second);
    expect(state.deal).toMatchObject({ stage: "follow_up", outcome: "open" });
    expect(state.tasks.filter((task) => task.status === "pending").map((task) => task._id)).toEqual([taskId]);
    expect(state.tasks.find((task) => task._id === taskId)).toMatchObject({ reminderScheduledAt: FIXTURE_NOW + 1000, contactMethod: "text" });
    expect(state.tasks.find((task) => task._id === taskId)?.completionPaymentId).toBeUndefined();
    await invariant();

    const shown = await previewRestore(f.admin, correctionId);
    expect((await restore(f.admin, correctionId, shown.fingerprint)).ok).toBe(true);
    state = await snapshot(f, second);
    expect(state.deal).toMatchObject({ outcome: "won", paymentReceivedAt: FIXTURE_NOW + 1000 });
    expect(state.tasks.find((task) => task._id === taskId))
      .toMatchObject({ status: "completed", completionOutcome: "payment_received", completionPaymentId: second });
    expect(state.tasks.filter((task) => task.status === "pending")).toEqual([]);
    await invariant();
    expect(await restore(f.admin, correctionId, shown.fingerprint)).toMatchObject({ ok: true, alreadyApplied: true });
    expect(await snapshot(f, second)).toEqual(state);
    await invariant();
  });

  it("restores no task when the exclusion closes the deal lost", async () => {
    const { f, invariant, taskId, first, second } = await reminderPaid();
    await exclude(f.admin, { paymentRecordId: second, cause: "refund", level: "reviewed" });
    await exclude(f.admin, { paymentRecordId: first, cause: "refund", level: "reviewed", disposition: "lost" });
    const state = await snapshot(f, first);
    expect(state.deal).toMatchObject({ outcome: "lost", lostReason: "payment_excluded" });
    expect(state.tasks.filter((task) => task.status === "pending")).toEqual([]);
    expect(state.tasks.find((task) => task._id === taskId)?.status).toBe("completed");
    await invariant();
  });
});
