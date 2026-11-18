import { anyApi, type ApiFromModules } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertAutomationInvariants } from "../../tests/automationInvariants";
import { callInsightsHarness, seedCallDecisionReading } from "../../tests/callInsightsHarness";
import { insertProgram } from "../../tests/enrollmentFixtures";
import { storeProofFile } from "../../tests/proofFixtures";
import {
  insertPaymentFixtureConnection, insertProviderDeal, insertProviderFact, seedAppliedReceipt,
} from "../../tests/providerPaymentFixtures";
import { api, internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { sha256Hex } from "../lib/stableHash";
import { insertMeetingAggregate, insertOpportunityAggregate } from "../reporting/writeHooks";
import { evaluateCallSubject } from "./callDecisions";

const alerts = (anyApi as unknown as ApiFromModules<{
  "automation/alert": typeof import("./alert");
}>).automation.alert;
const NOW = Date.parse("2026-11-17T19:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CALL_AT = NOW - 4 * HOUR;
const WINDOW = { from: NOW - 1, to: NOW + 1 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function publish(f: Awaited<ReturnType<typeof callInsightsHarness>>, generation = 1) {
  const reading = await seedCallDecisionReading(f, { alert: true, generation });
  await f.t.mutation(internal.callInsights.run.publish, reading);
  return await f.t.run((ctx) => evaluateCallSubject(ctx, {
    tenantId: f.tenantId, meetingId: f.meetingId, cause: "published", now: Date.now(),
  }));
}

async function setup(mode: "on" | "shadow" | "off" = "on") {
  const f = await callInsightsHarness();
  const programId = await f.t.run(async (ctx) => {
    await ctx.db.patch("tenants", f.tenantId, { billingOpsEnabled: true });
    await ctx.db.patch("meetings", f.meetingId, { scheduledAt: CALL_AT });
    await ctx.db.patch("callRecordings", f.recordingId, {
      recordingStartAt: CALL_AT, recordingEndAt: CALL_AT + 34 * 60_000,
    });
    await insertMeetingAggregate(ctx, f.meetingId);
    await insertOpportunityAggregate(ctx, f.opportunityId);
    return await insertProgram(ctx, f.tenantId, "Scale Program");
  });
  await f.owner.mutation(api.automation.settings.setEnabled, { enabled: true });
  await f.owner.mutation(api.automation.settings.setAlertMode, { mode });
  const { decisionIds } = await publish(f);
  return { ...f, programId, decisionIds };
}

async function setupAlert(mode: "on" | "shadow" = "on") {
  const f = await setup(mode);
  const [decisionId] = f.decisionIds;
  expect(f.decisionIds).toHaveLength(1);
  return { ...f, decisionId };
}

type Fixture = Awaited<ReturnType<typeof setupAlert>>;
const row = (f: Fixture) => f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", f.decisionId));
const list = (f: Fixture) => f.closer.query(alerts.listMyAlerts, {});
const handoffs = (f: Fixture) => f.admin.query(alerts.listAlertHandoffs, {});
const answer = (f: Fixture, answer: "add_payment" | "paid_in_whop_by_someone_else" | "not_paid_yet") =>
  f.closer.mutation(alerts.answerAlert, { decisionId: f.decisionId, answer });
const assertInvariants = (f: Awaited<ReturnType<typeof setup>>) => assertAutomationInvariants(f.t, { tenantId: f.tenantId });

function expectedRow(f: Fixture) {
  return {
    decisionId: f.decisionId, meetingId: f.meetingId, opportunityId: f.opportunityId,
    leadId: f.leadId, personName: "Grace", callAt: CALL_AT,
  };
}

async function seedCountingPayment(
  f: Fixture, kind: "manual" | "confirmed" | "automatic",
  options: { recordedAt?: number; status?: Doc<"paymentRecords">["status"] } = {},
) {
  return await f.t.run(async (ctx) => {
    // A different deal proves that the guard follows the person, not the alert's deal.
    const opportunityId = await insertProviderDeal(ctx, { tenantId: f.tenantId, leadId: f.leadId });
    const automatic = kind === "automatic";
    const recordedAt = options.recordedAt ?? Date.now();
    const providerPaymentId = kind === "manual" ? undefined : await insertProviderFact(
      ctx, f.tenantId, await insertPaymentFixtureConnection(ctx, f.tenantId, f.ownerId),
      { leadId: f.leadId, opportunityId, reviewState: "recorded" },
    );
    let automationDecisionId;
    if (automatic) {
      const certificateSampleId = await ctx.db.insert("automationSamples", {
        tenantId: f.tenantId, kind: "payment_win", ruleVersion: "payment-rule@1",
        target: 0, status: "certified", certifiedAt: NOW, createdAt: NOW,
      });
      automationDecisionId = await seedAppliedReceipt(ctx, {
        tenantId: f.tenantId, leadId: f.leadId, opportunityId, providerPaymentId, certificateSampleId,
      });
      await ctx.db.patch("resultAutomationDecisions", automationDecisionId, { mode: "automatic" });
    }
    const paymentRecordId = await ctx.db.insert("paymentRecords", {
      tenantId: f.tenantId, opportunityId, recordedAt, amountMinor: 10000, currency: "USD",
      programId: f.programId, programName: "Scale Program", paymentType: "pif",
      status: options.status ?? (kind === "confirmed" ? "verified" : "recorded"),
      recordedByUserId: automatic ? undefined : f.closerId,
      origin: kind === "manual" ? "closer_meeting" : "provider",
      providerPaymentId, automationDecisionId,
    });
    if (providerPaymentId) await ctx.db.patch("providerPayments", providerPaymentId, { paymentRecordId });
    if (automationDecisionId) await ctx.db.patch("resultAutomationDecisions", automationDecisionId, { appliedPaymentRecordId: paymentRecordId });
    return paymentRecordId;
  });
}

async function seedMatch(f: Fixture) {
  await f.t.run(async (ctx) => insertProviderFact(
    ctx, f.tenantId, await insertPaymentFixtureConnection(ctx, f.tenantId, f.ownerId),
    { candidateLeadId: f.leadId, reviewState: "needs_person", status: "pending" },
  ));
}

async function assertNoDealResult(f: Fixture) {
  const { deal, meeting, payments, reminders } = await f.t.run(async (ctx) => ({
    deal: await ctx.db.get("opportunities", f.opportunityId),
    meeting: await ctx.db.get("meetings", f.meetingId),
    payments: await ctx.db.query("paymentRecords").withIndex("by_opportunityId_and_recordedAt", (q) =>
      q.eq("opportunityId", f.opportunityId)).take(1),
    reminders: await ctx.db.query("followUps").withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q.eq("opportunityId", f.opportunityId)).take(1),
  }));
  expect(deal).toMatchObject({ stage: "booked", outcome: "open" });
  expect(deal?.humanResultRevision).toBeUndefined();
  expect(meeting?.status).toBe("scheduled");
  expect(payments).toEqual([]);
  expect(reminders).toEqual([]);
}

describe("closer alerts", () => {
  it("stays open when Add payment opens the dialog and closes on the real save", async () => {
    const f = await setupAlert();
    expect(await list(f)).toEqual([expectedRow(f)]);
    expect(await row(f)).toMatchObject({ state: "ready", mode: "ask", dueAt: CALL_AT + 154 * 60_000 });
    const before = await row(f);
    expect(await answer(f, "add_payment")).toEqual({
      ok: true, alreadyApplied: false, next: { type: "payment", target: { meetingId: f.meetingId } },
    });
    expect(await row(f)).toEqual(before);
    expect(await list(f)).toEqual([expectedRow(f)]);
    await assertNoDealResult(f);
    await assertInvariants(f);

    const proofFileId = await storeProofFile(f.t);
    await f.closer.mutation(api.closer.payments.logPayment, {
      opportunityId: f.opportunityId, meetingId: f.meetingId, amount: 100,
      currency: "USD", programId: f.programId, paymentType: "pif", proofFileId,
    });
    expect(await row(f)).toMatchObject({ state: "stopped" });
    expect(await list(f)).toEqual([]);
    expect(await f.t.run((ctx) => ctx.db.get("opportunities", f.opportunityId))).toMatchObject({ humanResultRevision: 1 });
    await assertInvariants(f);
  });

  it("routes Add payment to the closer's pending reminder when it takes over the outcome", async () => {
    const f = await setupAlert();
    const followUpId = await f.t.run((ctx) => ctx.db.insert("followUps", {
      tenantId: f.tenantId, opportunityId: f.opportunityId, leadId: f.leadId, closerId: f.closerId,
      status: "pending", type: "manual_reminder", reason: "closer_initiated", contactMethod: "call",
      reminderScheduledAt: NOW + HOUR, createdAt: NOW,
    }));
    expect(await answer(f, "add_payment")).toEqual({
      ok: true, alreadyApplied: false, next: { type: "payment", target: { followUpId } },
    });
    expect(await row(f)).toMatchObject({ state: "ready" });
    await assertInvariants(f);
  });

  it("returns reminder prefill and records only the fixed answer when Not paid yet is picked", async () => {
    const f = await setupAlert();
    expect(await answer(f, "not_paid_yet")).toEqual({
      ok: true, alreadyApplied: false,
      next: { type: "reminder", purpose: "payment_owed", opportunityId: f.opportunityId, meetingId: f.meetingId },
    });
    expect(await row(f)).toMatchObject({ state: "applied", alertAnswer: "not_paid_yet", resolvedByUserId: f.closerId });
    expect(await answer(f, "paid_in_whop_by_someone_else")).toEqual({ ok: true, alreadyApplied: true, next: null });
    expect(await list(f)).toEqual([]);
    expect(await handoffs(f)).toEqual([]);
    await assertNoDealResult(f);
    await assertInvariants(f);

    await publish(f, 2);
    expect(await list(f)).toEqual([]);
    await assertInvariants(f);

    await f.closer.mutation(api.closer.followUpMutations.createManualReminderFollowUpPublic, {
      opportunityId: f.opportunityId, meetingId: f.meetingId,
      contactMethod: "call", reminderScheduledAt: NOW + DAY,
    });
    expect(await f.t.run((ctx) => ctx.db.get("opportunities", f.opportunityId))).toMatchObject({ humanResultRevision: 1 });
    expect(await list(f)).toEqual([]);
    await assertInvariants(f);
  });

  it("requires the assigned closer and allows a displayed alert to finish after mode is turned off", async () => {
    const f = await setupAlert();
    expect(await list(f)).toEqual([expectedRow(f)]);
    expect(await f.other.query(alerts.listMyAlerts, {})).toEqual([]);
    expect(await f.other.mutation(alerts.answerAlert, { decisionId: f.decisionId, answer: "not_paid_yet" }))
      .toEqual({ ok: false, code: "not_yours" });
    expect(await row(f)).toMatchObject({ state: "ready" });
    await f.admin.mutation(api.automation.settings.setAlertMode, { mode: "off" });
    expect(await list(f)).toEqual([]);
    expect(await answer(f, "not_paid_yet")).toMatchObject({ ok: true, alreadyApplied: false });
    await assertInvariants(f);
  });

  it("shows nothing when the tenant starts in Off", async () => {
    const f = await setup("off");
    expect(f.decisionIds).toEqual([]);
    expect(await f.closer.query(alerts.listMyAlerts, {})).toEqual([]);
    expect(await f.admin.query(alerts.listAlertHandoffs, {})).toEqual([]);
    expect(await f.owner.query(alerts.getAlertMetrics, WINDOW)).toEqual({
      wouldRaise: 0, falseAlarms: 0, open: 0, over24Hours: 0, capped: false,
    });
    await assertInvariants(f);
  });
});

describe("Billing handoffs", () => {
  it.each(["payment_found", "no_payment_found"] as const)("hands over the deal and resolves it as %s", async (resolution) => {
    const f = await setupAlert();
    expect(await answer(f, "paid_in_whop_by_someone_else")).toEqual({ ok: true, alreadyApplied: false, next: null });
    expect(await row(f)).toMatchObject({ state: "needs_person", alertAnswer: "paid_by_someone_else" });
    expect(await row(f)).not.toHaveProperty("noticeUserId");
    expect(await answer(f, "not_paid_yet")).toEqual({ ok: true, alreadyApplied: true, next: null });
    expect(await list(f)).toEqual([]);
    vi.setSystemTime(NOW + HOUR);
    expect(await handoffs(f)).toEqual([{ ...expectedRow(f), ageMs: HOUR }]);
    await expect(f.closer.query(alerts.listAlertHandoffs, {})).rejects.toThrow("Insufficient permissions");
    await expect(f.closer.mutation(alerts.resolveAlertHandoff, { decisionId: f.decisionId, resolution }))
      .rejects.toThrow("Insufficient permissions");
    await assertNoDealResult(f);
    await assertInvariants(f);

    // A re-read can replace the outstanding decision, but the handoff still belongs to Billing.
    await publish(f, 2);
    expect(await list(f)).toEqual([]);
    expect(await handoffs(f)).toEqual([{ ...expectedRow(f), ageMs: HOUR }]);
    await assertInvariants(f);

    if (resolution === "payment_found") {
      await seedCountingPayment(f, "confirmed");
      expect(await handoffs(f)).toEqual([]);
    }
    const resolve = () => f.admin.mutation(alerts.resolveAlertHandoff, { decisionId: f.decisionId, resolution });
    expect(await resolve()).toEqual({ ok: true, alreadyApplied: false });
    expect(await resolve()).toEqual({ ok: true, alreadyApplied: true });
    expect(await row(f)).toMatchObject({
      state: "applied", alertAnswer: resolution === "payment_found" ? "linked" : "no_payment_found", resolvedByUserId: f.adminId,
    });
    expect(await handoffs(f)).toEqual([]);
    await assertNoDealResult(f);
    await assertInvariants(f);
  });

  it("requires Billing Ops to read or resolve the queue", async () => {
    const f = await setupAlert();
    await answer(f, "paid_in_whop_by_someone_else");
    await f.t.run((ctx) => ctx.db.patch("tenants", f.tenantId, { billingOpsEnabled: false }));
    await expect(handoffs(f)).rejects.toThrow("Billing Ops is not enabled");
    await expect(f.admin.mutation(alerts.resolveAlertHandoff, { decisionId: f.decisionId, resolution: "no_payment_found" }))
      .rejects.toThrow("Billing Ops is not enabled");
    await assertInvariants(f);
  });
});

describe("payment liveness and shadow measurement", () => {
  it.each(["manual", "confirmed", "automatic"] as const)("hides a ready alert after a %s payment even if its hook has not run", async (kind) => {
    const f = await setupAlert();
    expect(await list(f)).toEqual([expectedRow(f)]);
    await seedCountingPayment(f, kind);
    expect(await row(f)).toMatchObject({ state: "ready" });
    expect(await list(f)).toEqual([]);
    expect(await answer(f, "not_paid_yet")).toEqual({ ok: false, code: "alert_closed" });
    expect(await f.owner.query(alerts.getAlertMetrics, WINDOW)).toMatchObject({ open: 0 });
    await assertInvariants(f);
  });

  it("hides a ready alert on an unresolved Whop match while ignoring older or disputed CRM payments", async () => {
    const f = await setupAlert();
    await seedCountingPayment(f, "manual", { recordedAt: CALL_AT - HOUR });
    await seedCountingPayment(f, "manual", { status: "disputed" });
    expect(await list(f)).toEqual([expectedRow(f)]);
    await assertInvariants(f);

    await seedMatch(f);
    expect(await list(f)).toEqual([]);
    expect(await answer(f, "not_paid_yet")).toEqual({ ok: false, code: "alert_closed" });
    expect(await row(f)).toMatchObject({ state: "ready" });
    expect(await f.owner.query(alerts.getAlertMetrics, WINDOW)).toMatchObject({ open: 0, falseAlarms: 0 });
    await assertInvariants(f);
  });

  it.each([6, 8])("counts overdue shadow alerts and measures a payment %i days after the alert", async (days) => {
    const f = await setupAlert("shadow");
    expect(await row(f)).toMatchObject({ state: "shadow", mode: "shadow", kind: "paid_on_call_alert" });
    expect(await list(f)).toEqual([]);
    await expect(f.closer.query(alerts.getAlertMetrics, WINDOW)).rejects.toThrow("Insufficient permissions");
    expect(await f.owner.query(alerts.getAlertMetrics, { ...WINDOW, asOf: NOW + DAY })).toEqual({
      wouldRaise: 1, falseAlarms: 0, open: 1, over24Hours: 0, capped: false,
    });
    expect(await f.admin.query(alerts.getAlertMetrics, { ...WINDOW, asOf: NOW + DAY + 1 })).toEqual({
      wouldRaise: 1, falseAlarms: 0, open: 1, over24Hours: 1, capped: false,
    });
    await assertInvariants(f);

    vi.setSystemTime(NOW + days * DAY);
    await seedCountingPayment(f, "manual");
    expect(await f.owner.query(alerts.getAlertMetrics, WINDOW)).toEqual({
      wouldRaise: 1, falseAlarms: days <= 7 ? 1 : 0, open: 0, over24Hours: 0, capped: false,
    });
    expect(await f.owner.query(alerts.getAlertMetrics, { from: NOW + 1, to: NOW + DAY })).toMatchObject({ wouldRaise: 0 });
    await assertInvariants(f);
  });

  it("flags capped counts only when the indexed window exceeds the decision scan limit", async () => {
    const f = await setupAlert("shadow");
    await f.t.run(async (ctx) => {
      const original = (await ctx.db.get("resultAutomationDecisions", f.decisionId))!;
      const { _id, _creationTime, ...fields } = original;
      void _id;
      void _creationTime;
      for (let i = 0; i < 200; i++) {
        await ctx.db.insert("resultAutomationDecisions", {
          ...fields, state: "superseded", createdAt: NOW + HOUR,
          ruleVersion: original.ruleVersion.replace("|p2|", "|p3|"),
          inputKey: await sha256Hex(`superseded-${i}`), vetoKey: await sha256Hex(`older-alert-${i}`),
        });
      }
    });
    expect(await f.owner.query(alerts.getAlertMetrics, WINDOW)).toMatchObject({ capped: false, wouldRaise: 1 });
    expect(await f.owner.query(alerts.getAlertMetrics, {
      from: NOW - 1, to: NOW + 2 * HOUR, asOf: NOW + HOUR,
    })).toMatchObject({ capped: true, wouldRaise: 200 });
    await assertInvariants(f);
  });
});
