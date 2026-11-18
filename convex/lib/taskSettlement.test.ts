import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertAutomationInvariants } from "../../tests/automationInvariants";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import { FIXTURE_NOW, paymentConfirmationFixture } from "../../tests/providerPaymentFixtures";
import { storeProofFile } from "../../tests/proofFixtures";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { applyProviderPayment, previewProviderApply } from "../payments/apply";
import {
  completedByPayment, settleExcludedPaymentTasks, settleRestoredPaymentTasks,
} from "./taskSettlement";

type Fixture = Awaited<ReturnType<typeof paymentConfirmationFixture>>;
const DUE = FIXTURE_NOW + 3600_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function check(f: Fixture) {
  await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  await assertAutomationInvariants(f.t, { tenantId: f.tenantId });
}

async function prepare(expectedCurrency = "USD") {
  const f = await paymentConfirmationFixture({ dealPosition: "follow_up" });
  const followUpId = await f.t.run((ctx) => ctx.db.insert("followUps", {
    tenantId: f.tenantId, opportunityId: f.dealId, leadId: f.personId, closerId: f.closerId,
    type: "manual_reminder", reason: "call_insights", status: "pending",
    purpose: "payment_owed", expectedCurrency, expectedAmountMinor: 20_000,
    promisedPaymentAt: DUE, declineCode: "generic_decline",
    contactMethod: "text", reminderScheduledAt: DUE, createdAt: FIXTURE_NOW - 5000,
  }));
  return { f, followUpId };
}

async function providerWin(f: Fixture) {
  return await f.t.run(async (ctx) => {
    const args = { tenantId: f.tenantId, opportunityId: f.dealId, providerPaymentId: f.providerPaymentId, now: FIXTURE_NOW };
    const preview = await previewProviderApply(ctx, args);
    if (!preview.ok) throw new Error(preview.code);
    const result = await applyProviderPayment(ctx, {
      ...args, expectedFingerprint: preview.fingerprint, expectedAllocationRevision: preview.allocationRevision,
      approver: { userId: f.adminId, role: "tenant_admin", source: "admin" }, via: "billing",
    });
    if (!result.ok) throw new Error(result.code);
    return result.paymentRecordId;
  });
}

async function exclude(f: Fixture, paymentRecordId: Id<"paymentRecords">, disposition?: "follow_up" | "lost") {
  const args = { paymentRecordId, cause: "refund" as const };
  const { fingerprint } = await f.admin.query(api.payments.exclude.previewExclusion, args);
  const result = await f.admin.mutation(api.payments.exclude.excludePayment, {
    ...args, expectedFingerprint: fingerprint, level: "reviewed", disposition, followUpContactMethod: "text",
  });
  if (!result.ok) throw new Error(result.code);
  return result.correctionId;
}

describe("C2 payment-owed settlement", () => {
  it("completes the matching promise, expires other tasks, and shows the difference in both reminder readers", async () => {
    const { f, followUpId } = await prepare();
    const nudgeId = await f.t.run((ctx) => ctx.db.insert("followUps", {
      tenantId: f.tenantId, opportunityId: f.dealId, leadId: f.personId, closerId: f.closerId,
      type: "manual_reminder", reason: "stale_opportunity_nudge", status: "pending", createdAt: FIXTURE_NOW - 5000,
    }));
    await check(f);
    expect(await f.t.run((ctx) => previewProviderApply(ctx, {
      tenantId: f.tenantId, opportunityId: f.dealId, providerPaymentId: f.providerPaymentId, now: FIXTURE_NOW,
    }))).toMatchObject({ proposal: { completesFollowUpId: followUpId, expiresFollowUpIds: [nudgeId] } });
    const paymentRecordId = await providerWin(f);
    await check(f);
    await f.t.run(async (ctx) => {
      expect(await ctx.db.get("followUps", followUpId)).toMatchObject({
        status: "completed", completionOutcome: "payment_received", completionPaymentId: paymentRecordId,
      });
      expect(await ctx.db.get("followUps", nudgeId)).toMatchObject({ status: "expired" });
      const events = await ctx.db.query("domainEvents")
        .withIndex("by_tenantId_and_eventType_and_occurredAt", (q) =>
          q.eq("tenantId", f.tenantId).eq("eventType", "followUp.completed"))
        .take(2);
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0].metadata!)).toMatchObject({
        expectedAmountMinor: 20_000, paidAmountMinor: 10_000, differenceMinor: -10_000, code: "amount_differs",
      });
    });

    const results = [
      await f.closer.query(api.closer.reminderDetail.getReminderDetail, { followUpId }),
      await f.admin.query(api.pipeline.reminderDetail.getAdminReminderDetail, { followUpId }),
    ];
    for (const result of results) {
      expect(result).toMatchObject({
        followUp: { purpose: "payment_owed", expectedAmountMinor: 20_000, expectedCurrency: "USD", promisedPaymentAt: DUE, declineCode: "generic_decline" },
        completedByPayment: {
          paymentRecordId, amountMinor: 10_000, currency: "USD", recordedAt: FIXTURE_NOW,
          differenceMinor: -10_000, differenceCode: "amount_differs",
        },
      });
    }
  });

  it("does not mark a different currency as payment received", async () => {
    const { f, followUpId } = await prepare("EUR");
    await providerWin(f);
    await check(f);
    const task = await f.t.run((ctx) => ctx.db.get("followUps", followUpId));
    expect(task?.completionPaymentId).toBeUndefined();
    expect(task?.completionOutcome).toBeUndefined();
    expect(task?.status).toBe("expired");
  });

  it("records the difference for a payment logged from the reminder", async () => {
    const { f, followUpId } = await prepare();
    const paymentRecordId = await f.closer.mutation(api.closer.reminderOutcomes.logReminderPayment, {
      followUpId, amount: 250, currency: "USD", programId: f.programId, paymentType: "deposit",
      proofFileId: await storeProofFile(f.t),
      provider: { kind: "different_money", pins: [{ providerPaymentId: f.providerPaymentId, allocationRevision: 0 }] },
    });
    expect(await f.closer.query(api.closer.reminderDetail.getReminderDetail, { followUpId })).toMatchObject({
      completedByPayment: { paymentRecordId, amountMinor: 25_000, differenceMinor: 5000 },
    });
    await check(f);
  });

  it("repoints an excluded completing payment to the next qualifying survivor", async () => {
    const { f, followUpId } = await prepare();
    const first = await providerWin(f);
    await check(f);
    vi.setSystemTime(FIXTURE_NOW + 1000);
    const { paymentId: second } = await f.closer.mutation(api.closer.additionalPayment.recordAdditionalPayment, {
      opportunityId: f.dealId, amount: 200, currency: "USD", paymentType: "split", proofFileId: await storeProofFile(f.t),
      provider: { kind: "different_money", pins: [{ providerPaymentId: f.providerPaymentId, allocationRevision: 1 }] },
    });
    await check(f);
    const correctionId = await exclude(f, first);
    await check(f);
    const task = await f.t.run((ctx) => ctx.db.get("followUps", followUpId));
    expect(task).toMatchObject({ status: "completed", completionPaymentId: second });

    const { fingerprint } = await f.admin.query(api.payments.restore.previewRestore, { correctionId });
    const args = { correctionId, expectedFingerprint: fingerprint };
    expect(await f.admin.mutation(api.payments.restore.restorePayment, args)).toMatchObject({ ok: true });
    await check(f);
    expect(await f.admin.mutation(api.payments.restore.restorePayment, args)).toMatchObject({ ok: true, alreadyApplied: true });
    await check(f);
  });

  it.each(["follow_up", "lost"] as const)("restores and retries after a zero-survivor %s exclusion", async (disposition) => {
    const { f, followUpId } = await prepare();
    const first = await providerWin(f);
    await check(f);
    const correctionId = await exclude(f, first, disposition);
    await check(f);
    const task = await f.t.run((ctx) => ctx.db.get("followUps", followUpId));
    expect(task?.status).toBe(disposition === "follow_up" ? "pending" : "completed");
    const { fingerprint } = await f.admin.query(api.payments.restore.previewRestore, { correctionId });
    const args = { correctionId, expectedFingerprint: fingerprint };
    expect(await f.admin.mutation(api.payments.restore.restorePayment, args)).toMatchObject({ ok: true });
    await check(f);
    expect(await f.admin.mutation(api.payments.restore.restorePayment, args)).toMatchObject({ ok: true, alreadyApplied: true });
    await check(f);
  });

  it("keeps a promise date on reopen and completes it on restore even when the win receipt names it", async () => {
    const { f, followUpId } = await prepare();
    const first = await providerWin(f);
    const correctionId = await exclude(f, first, "lost");
    await check(f);
    const args = {
      correctionId,
      expectedFingerprint: (await f.admin.query(api.payments.restore.previewRestore, { correctionId })).fingerprint,
    };
    expect(await f.admin.mutation(api.payments.restore.restorePayment, args)).toMatchObject({ ok: true });
    await check(f);

    await f.t.run(async (ctx) => {
      const opportunity = (await ctx.db.get("opportunities", f.dealId))!;
      const task = (await ctx.db.get("followUps", followUpId))!;
      const payment = (await ctx.db.get("paymentRecords", first))!;
      expect(await settleExcludedPaymentTasks(ctx, {
        opportunity, completedTasks: [task], survivors: [], followUp: { kind: "reopen", task },
        correctionId, actorUserId: f.adminId, now: FIXTURE_NOW,
      })).toEqual([{ followUpId, change: "reopened" }]);
      const reopened = (await ctx.db.get("followUps", followUpId))!;
      expect(reopened).toMatchObject({ status: "pending", reminderScheduledAt: DUE });
      expect(reopened.completionPaymentId).toBeUndefined();
      expect(await settleRestoredPaymentTasks(ctx, {
        payment, closeTasks: [{ task: reopened, change: "reopened" }], winExpiredTaskIds: new Set([followUpId]),
        restoreId: correctionId, actorUserId: f.adminId, now: FIXTURE_NOW,
      })).toEqual([{ followUpId, change: "completed" }]);
      const restored = (await ctx.db.get("followUps", followUpId))!;
      expect(completedByPayment(restored, payment)).toMatchObject({ paymentRecordId: first, differenceMinor: -10_000 });
    });
    await check(f);
  });
});
