import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertAutomationInvariants, type AutomationInvariantId } from "../../tests/automationInvariants";
import { callTaskFixture, readCallForTask } from "../../tests/callInsightsHarness";
import { insertProgram } from "../../tests/enrollmentFixtures";
import { assertPaymentInvariants, type InvariantId } from "../../tests/paymentInvariants";
import {
  FIXTURE_NOW, insertProviderBinding, insertProviderFact, insertProviderMeeting, paymentConfirmationFixture,
  PRODUCT_ID, seedAutomaticCertificate, seedBillingWin, VARIANT_ID,
} from "../../tests/providerPaymentFixtures";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { AUTOMATIC_WIN_GRACE_MS } from "./automaticPayments";
import { evaluateSubject } from "./decisions";
import { PAYMENT_RULE_VERSION } from "./derive";
import { noteHumanResult } from "./humanResult";

const NOW = FIXTURE_NOW;
const GRACE = AUTOMATIC_WIN_GRACE_MS;
const undo = api.automation.undo.undoAutomaticWrite;
const list = api.automation.undo.listAutomaticWrites;
const executeTask = internal.automation.apply.executeCallTask;
const executePayment = internal.automation.automaticPayments.executeAutomaticPayment;
type Scoped = { t: Parameters<typeof assertPaymentInvariants>[0]; tenantId: Id<"tenants"> };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// After a one-tap undo the excluded row keeps its provenance and has no
// recorder, while its receipt is `undone`. I5 and A9 still name "an applied
// automatic decision" for such a row, so those two are skipped on that step
// only, and the row's receipt is asserted directly instead.
const UNDONE_ROW: { payment: InvariantId[]; automation: AutomationInvariantId[] } = { payment: ["I5"], automation: ["A9"] };

async function invariants(f: Scoped, skip?: typeof UNDONE_ROW) {
  await assertPaymentInvariants(f.t, { tenantId: f.tenantId }, { skip: skip?.payment });
  await assertAutomationInvariants(f.t, { tenantId: f.tenantId }, { skip: skip?.automation });
}

async function automaticWin() {
  const f = await paymentConfirmationFixture();
  await seedAutomaticCertificate(f.t, {
    tenantId: f.tenantId, promotedByUserId: f.ownerId, kind: "payment_win", ruleVersion: PAYMENT_RULE_VERSION,
    scopeBindingIds: [f.productBindingId, f.variantBindingId],
  });
  const meetingId = await f.t.run((ctx) => insertProviderMeeting(ctx, {
    tenantId: f.tenantId, opportunityId: f.dealId, closerId: f.closerId, scheduledAt: NOW + 2 * 3_600_000,
  }));
  const { decisionId } = await f.t.run((ctx) => evaluateSubject(ctx, {
    tenantId: f.tenantId, providerPaymentId: f.providerPaymentId, cause: "provider_read", now: NOW,
  }));
  vi.setSystemTime(NOW + GRACE);
  expect(await f.t.mutation(executePayment, { decisionId: decisionId! })).toBe("applied");
  const receipt = (await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", decisionId!)))!;
  return { ...f, meetingId, decisionId: decisionId!, paymentRecordId: receipt.appliedPaymentRecordId! };
}

async function automaticTask(kind: "call_back" | "payment_owed" = "call_back") {
  const f = await callTaskFixture(kind, true);
  const decisionId = await readCallForTask(f, kind);
  const applied = await f.t.mutation(executeTask, { decisionId });
  if (!applied.ok) throw new Error(applied.code);
  return { ...f, decisionId, followUpId: applied.followUpId };
}

describe("undoAutomaticWrite: payments", () => {
  it("returns an untouched automatic win to where it found the deal, in one tap", async () => {
    const f = await automaticWin();
    const writes = await f.admin.query(list, { days: 7 });
    expect(writes).toMatchObject({ capped: false, writes: [{
      decisionId: f.decisionId, kind: "payment_win", paymentRecordId: f.paymentRecordId, untouched: true, auditReason: "canary", before: { position: "booked" },
    }] });
    await expect(f.closer.query(list, { days: 7 })).rejects.toThrow("Insufficient permissions");
    await expect(f.closer.mutation(undo, { decisionId: f.decisionId })).rejects.toThrow("Insufficient permissions");

    expect(await f.admin.mutation(undo, { decisionId: f.decisionId })).toEqual({ ok: true, alreadyApplied: false });
    const [deal, row, receipt, payment, meeting] = await f.t.run(async (ctx) => [
      await ctx.db.get("opportunities", f.dealId),
      await ctx.db.get("paymentRecords", f.paymentRecordId),
      await ctx.db.get("resultAutomationDecisions", f.decisionId),
      await ctx.db.get("providerPayments", f.providerPaymentId),
      await ctx.db.get("meetings", f.meetingId),
    ] as const);
    expect(deal).toMatchObject({ stage: "booked", outcome: "open" });
    expect(deal?.paymentReceivedAt).toBeUndefined();
    expect(row).toMatchObject({ status: "disputed", origin: "provider", automationDecisionId: f.decisionId });
    expect(row?.recordedByUserId).toBeUndefined();
    expect(receipt).toMatchObject({ state: "undone", mode: "automatic", appliedVia: "automatic" });
    expect(receipt?.auditOpenDueAt).toBe(writes.writes[0].auditOpenDueAt);
    expect(payment?.paymentRecordId).toBeUndefined();
    expect(payment?.excludedOpportunityIds).toEqual([f.dealId]);
    expect(meeting).toMatchObject({ status: "scheduled" });
    expect(meeting?.attendanceOwedSince).toBeUndefined();
    await invariants(f, UNDONE_ROW);

    expect(await f.admin.mutation(undo, { decisionId: f.decisionId })).toEqual({ ok: true, alreadyApplied: true });
    expect((await f.admin.query(list, { days: 7 })).writes).toEqual([]);
  });

  it("refuses automatic payment Undo when Billing Ops is off", async () => {
    const f = await automaticWin();
    await f.t.run((ctx) => ctx.db.patch("tenants", f.tenantId, { billingOpsEnabled: false }));
    await expect(f.admin.mutation(undo, { decisionId: f.decisionId })).rejects.toThrow("Billing Ops is not enabled");
    expect(await f.t.run((ctx) => ctx.db.get("paymentRecords", f.paymentRecordId))).toMatchObject({ status: "recorded" });
    await invariants(f);
  });

  it("undoes an untouched automatic later payment and leaves the first payment and win intact", async () => {
    const membershipId = "mem_undo_later";
    const f = await paymentConfirmationFixture({ fact: { membershipId } });
    const { membershipBindingId, providerPaymentId, paymentRecordId } = await f.t.run(async (ctx) => {
      const { paymentRecordId } = await seedBillingWin(ctx, {
        ...f, opportunityId: f.dealId, approverId: f.adminId, recordedAt: NOW,
      });
      const membershipBindingId = await insertProviderBinding(ctx, {
        ...f, externalId: membershipId,
        binding: {
          kind: "membership_deal", leadId: f.personId, opportunityId: f.dealId,
          anchorPaymentRecordId: paymentRecordId,
        },
      });
      const providerPaymentId = await insertProviderFact(ctx, f.tenantId, f.connectionId, {
        externalPaymentId: "pay_undo_later", membershipId, billingReason: "subscription_cycle",
        paidAt: Date.now(), sourceCreatedAt: Date.now(), sourceUpdatedAt: Date.now(),
        reviewState: "needs_person", totalMinor: 4_000,
      });
      return { membershipBindingId, providerPaymentId, paymentRecordId };
    });
    await seedAutomaticCertificate(f.t, {
      tenantId: f.tenantId, promotedByUserId: f.ownerId, kind: "additional_payment", ruleVersion: PAYMENT_RULE_VERSION,
      scopeBindingIds: [membershipBindingId, f.productBindingId, f.variantBindingId],
      now: Date.now(),
    });
    const { decisionId } = await f.t.run((ctx) => evaluateSubject(ctx, {
      tenantId: f.tenantId, providerPaymentId, cause: "provider_read", now: Date.now(),
    }));
    expect(await f.t.mutation(executePayment, { decisionId: decisionId! })).toBe("applied");
    const receipt = (await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", decisionId!)))!;
    expect(receipt.kind).toBe("additional_payment");
    expect(await f.admin.mutation(undo, { decisionId: receipt._id })).toEqual({ ok: true, alreadyApplied: false });
    expect(await f.admin.mutation(undo, { decisionId: receipt._id })).toEqual({ ok: true, alreadyApplied: true });
    await f.t.run(async (ctx) => {
      expect(await ctx.db.get("opportunities", f.dealId)).toMatchObject({
        stage: "closed", outcome: "won", paymentReceivedAt: NOW,
      });
      expect(await ctx.db.get("paymentRecords", paymentRecordId)).toMatchObject({ status: "recorded" });
      expect(await ctx.db.get("paymentRecords", receipt.appliedPaymentRecordId!)).toMatchObject({ status: "disputed" });
      expect(await ctx.db.get("providerPayments", providerPaymentId)).toMatchObject({ excludedOpportunityIds: [f.dealId] });
      expect(await ctx.db.get("resultAutomationDecisions", receipt._id)).toMatchObject({ state: "undone" });
    });
    await invariants(f, UNDONE_ROW);
  });

  it("refuses one-tap undo after a person touched the deal", async () => {
    const f = await automaticWin();
    await f.t.run((ctx) => noteHumanResult(ctx, f.dealId, { tenantId: f.tenantId, userId: f.closerId }));
    expect((await f.admin.query(list, { days: 7 })).writes).toMatchObject([{ decisionId: f.decisionId, untouched: false }]);
    expect(await f.admin.mutation(undo, { decisionId: f.decisionId })).toEqual({ ok: false, code: "needs_review" });
    expect(await f.t.run((ctx) => ctx.db.get("opportunities", f.dealId))).toMatchObject({ stage: "closed", outcome: "won" });
    expect(await f.t.run((ctx) => ctx.db.get("paymentRecords", f.paymentRecordId))).toMatchObject({ status: "recorded" });
    await invariants(f);
  });
});

describe("undoAutomaticWrite: call tasks", () => {
  it("lets an admin undo an untouched task and the held mark when the call didn't happen", async () => {
    const f = await automaticTask();
    const original = await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", f.decisionId));
    await expect(f.admin.mutation(undo, { decisionId: f.decisionId })).rejects.toThrow("Say whether the call happened");
    expect(await f.closer.mutation(undo, { decisionId: f.decisionId, callHappened: false }))
      .toEqual({ ok: false, code: "not_yours" });
    expect(await f.admin.mutation(undo, { decisionId: f.decisionId, callHappened: false }))
      .toEqual({ ok: true, alreadyApplied: false });
    const [task, meeting, deal, decision] = await f.t.run(async (ctx) => [
      await ctx.db.get("followUps", f.followUpId),
      await ctx.db.get("meetings", f.meetingId),
      await ctx.db.get("opportunities", f.opportunityId),
      await ctx.db.get("resultAutomationDecisions", f.decisionId),
    ] as const);
    expect(task).toMatchObject({ status: "expired" });
    expect(meeting).toMatchObject({ status: "scheduled" });
    expect(meeting?.attendanceDecisionId).toBeUndefined();
    expect(deal).toMatchObject({ stage: "booked", outcome: "open" });
    expect(decision).toMatchObject({ state: "undone" });
    expect(decision?.auditOpenDueAt).toBe(original?.auditOpenDueAt);
    await invariants(f);
    expect(await f.admin.mutation(undo, { decisionId: f.decisionId, callHappened: false }))
      .toEqual({ ok: true, alreadyApplied: true });
  });

  it("keeps the original sampled task in the audit queue after its next step changes", async () => {
    const f = await automaticTask();
    const original = await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", f.decisionId));
    const scheduledAt = NOW + 86_400_000;
    await expect(f.closer.mutation(api.automation.taskCorrections.changeNextStep, {
      decisionId: f.decisionId, contactMethod: "text", reminderScheduledAt: scheduledAt,
    })).resolves.toMatchObject({ ok: true });
    const queue = await f.admin.query(api.automation.audit.listAuditQueue, {});
    expect(queue.cases).toMatchObject([{
      decisionId: f.decisionId, dueAt: original?.auditOpenDueAt, correction: "corrected",
      originalTask: { contactMethod: "call" },
      replacementTask: { contactMethod: "text", reminderScheduledAt: scheduledAt },
    }]);
    expect(await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", f.decisionId))).toMatchObject({
      proposal: original?.proposal, writtenFollowUpId: f.followUpId,
    });
    expect(await f.admin.mutation(api.automation.audit.recordAudit, {
      decisionId: f.decisionId, verdict: "wrong", wrongFields: ["person"],
    })).toEqual({ ok: true, alreadyApplied: false });
    expect((await f.admin.query(api.automation.audit.listAuditQueue, {})).cases).toEqual([]);
    await invariants(f);
  });

  it("lets the assigned closer undo their own task when the call happened, keeping the held call", async () => {
    const f = await automaticTask("payment_owed");
    expect(await f.closer.mutation(undo, { decisionId: f.decisionId, callHappened: true }))
      .toEqual({ ok: true, alreadyApplied: false });
    const [task, meeting] = await f.t.run(async (ctx) => [
      await ctx.db.get("followUps", f.followUpId), await ctx.db.get("meetings", f.meetingId),
    ] as const);
    expect(task).toMatchObject({ status: "expired" });
    expect(meeting).toMatchObject({ status: "held" });
    await invariants(f);
  });

  it("refuses one-tap undo after a person touched the deal", async () => {
    const f = await automaticTask();
    await f.t.run((ctx) => noteHumanResult(ctx, f.opportunityId, { tenantId: f.tenantId, userId: f.closerId }));
    expect(await f.admin.mutation(undo, { decisionId: f.decisionId, callHappened: false }))
      .toEqual({ ok: false, code: "needs_review" });
    expect(await f.t.run((ctx) => ctx.db.get("followUps", f.followUpId))).toMatchObject({ status: "pending" });
    await invariants(f);
  });
});

describe("undoAutomaticWrite: a task, then a win (X1)", () => {
  /** The harness call's person pays in Whop a minute after the call result was written. */
  async function taskThenWin(kind: "call_back" | "payment_owed") {
    const f = await automaticTask(kind);
    const paidAt = NOW + 60_000;
    const whop = await f.t.run(async (ctx) => {
      await ctx.db.patch("tenants", f.tenantId, { billingOpsEnabled: true });
      const programId = await insertProgram(ctx, f.tenantId, "Scale Program");
      const connectionId = await ctx.db.insert("tenantPaymentConnections", {
        tenantId: f.tenantId, provider: "whop", environment: "sandbox", accountId: "biz_d2", credentialKind: "account_key",
        apiKey: "fixture-key", keyLast4: "-key", apiVersionDate: "2026-11-16-2", status: "connected", disputeAccess: "ok",
        autoImportAfter: NOW - 30 * 86_400_000, connectedByUserId: f.adminId, connectedAt: NOW - 30 * 86_400_000,
        lastSuccessfulSweepAt: NOW,
      });
      const productBindingId = await insertProviderBinding(ctx, {
        tenantId: f.tenantId, connectionId, adminId: f.adminId, externalId: PRODUCT_ID, binding: { kind: "product_program", programId },
      });
      const variantBindingId = await insertProviderBinding(ctx, {
        tenantId: f.tenantId, connectionId, adminId: f.adminId, externalId: VARIANT_ID, binding: { kind: "variant_type", paymentType: "pif" },
      });
      const providerPaymentId = await insertProviderFact(ctx, f.tenantId, connectionId, {
        payerEmail: "grace@example.com", paidAt, sourceCreatedAt: paidAt, sourceUpdatedAt: paidAt, firstSeenAt: paidAt,
        reviewState: "needs_person",
      });
      return { providerPaymentId, productBindingId, variantBindingId };
    });
    await seedAutomaticCertificate(f.t, {
      tenantId: f.tenantId, promotedByUserId: f.ownerId, kind: "payment_win", ruleVersion: PAYMENT_RULE_VERSION,
      scopeBindingIds: [whop.productBindingId, whop.variantBindingId], now: NOW,
    });
    vi.setSystemTime(paidAt);
    const { decisionId: paymentDecisionId } = await f.t.run((ctx) => evaluateSubject(ctx, {
      tenantId: f.tenantId, providerPaymentId: whop.providerPaymentId, cause: "provider_read", now: paidAt,
    }));
    expect(await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", paymentDecisionId!))).toMatchObject({
      mode: "automatic", state: "ready", confirmRoute: "reminder", proposal: { completesFollowUpId: f.followUpId },
    });
    vi.setSystemTime(paidAt + GRACE);
    expect(await f.t.mutation(executePayment, { decisionId: paymentDecisionId! })).toBe("applied");
    return { ...f, ...whop, paymentDecisionId: paymentDecisionId! };
  }

  it.each([
    ["call_back", "expired"],
    ["payment_owed", "completed"],
  ] as const)("refuses to undo the %s task the win %s, and undoing the win restores it", async (kind, closedAs) => {
    const f = await taskThenWin(kind);
    const task = await f.t.run((ctx) => ctx.db.get("followUps", f.followUpId));
    expect(task).toMatchObject({ status: closedAs });
    expect(await f.t.run((ctx) => ctx.db.get("opportunities", f.opportunityId))).toMatchObject({ stage: "closed", outcome: "won" });
    await invariants(f);

    expect(await f.admin.mutation(undo, { decisionId: f.decisionId, callHappened: true }))
      .toEqual({ ok: false, code: "needs_review" });
    expect(await f.admin.mutation(undo, { decisionId: f.paymentDecisionId })).toEqual({ ok: true, alreadyApplied: false });
    const [restored, deal, taskDecision, meeting] = await f.t.run(async (ctx) => [
      await ctx.db.get("followUps", f.followUpId),
      await ctx.db.get("opportunities", f.opportunityId),
      await ctx.db.get("resultAutomationDecisions", f.decisionId),
      await ctx.db.get("meetings", f.meetingId),
    ] as const);
    expect(restored).toMatchObject({
      status: "pending", reminderScheduledAt: task?.reminderScheduledAt, purpose: kind, automationDecisionId: f.decisionId,
    });
    expect(restored?.completionPaymentId).toBeUndefined();
    expect(deal).toMatchObject({ stage: "follow_up", outcome: "open" });
    expect(taskDecision).toMatchObject({ state: "applied", mode: "automatic" });
    expect(meeting).toMatchObject({ status: "held", attendanceDecisionId: f.decisionId });
    await invariants(f, UNDONE_ROW);
  });
});
