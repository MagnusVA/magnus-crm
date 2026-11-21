import type { TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertAutomationInvariants } from "../../../tests/automationInvariants";
import {
  callInsightsHarness, callTaskFixture, seedCallDecisionReading,
} from "../../../tests/callInsightsHarness";
import { storeProofFile } from "../../../tests/proofFixtures";
import { assertPaymentInvariants } from "../../../tests/paymentInvariants";
import {
  FIXTURE_NOW, PRODUCT_ID, VARIANT_ID, automationPaymentFixture, insertPaymentFixtureConnection,
  insertProviderBinding, insertProviderDeal, insertProviderIdentifier, insertProviderMeeting, insertProviderPerson,
  seedAutomaticCertificate, seedReadablePaymentRecording, seedReadyDecision,
} from "../../../tests/providerPaymentFixtures";
import { iso, paymentFixture } from "../../../tests/whopFixtures";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { computeLatestActivityAt } from "../../lib/opportunityActivity";
import { sha256Hex } from "../../lib/stableHash";
import { normalizePayment, paymentSchema } from "../../payments/whop/normalize";
import { insertMeetingAggregate, insertOpportunityAggregate } from "../../reporting/writeHooks";
import type schema from "../../schema";
import { AUTOMATIC_WIN_GRACE_MS } from "../automaticPayments";
import { currentRuleVersion } from "../settings";

const rule = vi.hoisted(() => ({ version: undefined as string | undefined }));
vi.mock("../derive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../derive")>();
  return { ...actual, get PAYMENT_RULE_VERSION() { return rule.version ?? actual.PAYMENT_RULE_VERSION; } };
});

const HOUR = 3_600_000;
const MEMBERSHIP = "mem_auto_later";
const { audit, breaker, certificates, grading, notice, refusal, settings, taskCorrections, undo } = api.automation;
type Harness = { t: TestConvex<typeof schema>; tenantId: Id<"tenants"> };
type Call = Awaited<ReturnType<typeof callInsightsHarness>>;
type Payments = Awaited<ReturnType<typeof automationPaymentFixture>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  rule.version = undefined;
});

function scenarioSteps({ t, tenantId }: Harness) {
  return async function step<T>(name: string, act: () => Promise<T>): Promise<T> {
    try {
      const result = await act();
      const checks = await Promise.allSettled([
        assertPaymentInvariants(t, { tenantId }),
        assertAutomationInvariants(t, { tenantId }),
      ]);
      const failures = checks.flatMap((check) => check.status === "rejected" ? [check.reason] : []);
      if (failures.length) throw new AggregateError(failures, failures.map(String).join("\n"));
      return result;
    } catch (cause) {
      throw new Error(`Step: ${name}: ${String(cause)}`, { cause });
    }
  };
}

async function advanceTo({ t }: Harness, at: number) {
  vi.advanceTimersByTime(at - Date.now());
  await t.finishInProgressScheduledFunctions();
}

async function runImmediateWork(f: Harness) {
  // A scheduled evaluation can enqueue an executor at the current instant.
  // Yield between advances so the executor's timer is registered.
  await advanceTo(f, Date.now());
  await advanceTo(f, Date.now() + 1);
  await advanceTo(f, Date.now() + 1);
}

function decision({ t }: Harness, id: Id<"resultAutomationDecisions">) {
  return t.run((ctx) => ctx.db.get("resultAutomationDecisions", id));
}

async function payFromWhop(
  f: Harness,
  connectionId: Id<"tenantPaymentConnections">,
  externalPaymentId: string,
  email: string,
  overrides: Record<string, unknown> = {},
) {
  const connection = await f.t.run((ctx) => ctx.db.get("tenantPaymentConnections", connectionId));
  if (!connection) throw new Error("Missing Whop connection fixture");
  const identity = { connectionId, connectedAt: connection.connectedAt, accountId: connection.accountId, externalPaymentId };
  const generation = await f.t.mutation(internal.payments.intake.beginPaymentRead, identity);
  if (generation === null) throw new Error("Whop read did not start");
  const now = iso(Date.now());
  const payment = normalizePayment(paymentSchema.parse(paymentFixture({
    id: externalPaymentId, account_id: connection.accountId,
    customer_email: email, customer_phone: null, paid_at: now, created_at: now, updated_at: now,
    product_id: PRODUCT_ID, variant_id: VARIANT_ID, billing_reason: "one_time",
    total: { amount: "100.00", currency: "usd", decimals: 2 }, ...overrides,
  })));
  expect(await f.t.mutation(internal.payments.intake.storePaymentRead, { ...identity, generation, payment })).toBe("stored");
  const fact = await f.t.run((ctx) => ctx.db.query("providerPayments")
    .withIndex("by_tenantId_and_connectionId_and_externalPaymentId", (q) =>
      q.eq("tenantId", f.tenantId).eq("connectionId", connectionId).eq("externalPaymentId", externalPaymentId)).unique());
  if (!fact) throw new Error("Whop did not store the payment");
  return fact;
}

function paymentDecision(f: Harness, providerPaymentId: Id<"providerPayments">, state: "shadow" | "ready" | "applied") {
  return f.t.run((ctx) => ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_providerPaymentId_and_state", (q) =>
      q.eq("tenantId", f.tenantId).eq("providerPaymentId", providerPaymentId).eq("state", state)).unique());
}

async function freshWhopSweep(f: Harness, connectionId: Id<"tenantPaymentConnections">) {
  const connection = await f.t.run((ctx) => ctx.db.get("tenantPaymentConnections", connectionId));
  if (!connection) throw new Error("Missing Whop connection fixture");
  const token = "scenario-sweep";
  expect(await f.t.mutation(internal.payments.connectionState.takeSweepLease, { connectionId, token })).toBe("acquired");
  expect(await f.t.mutation(internal.payments.connectionState.releaseSweepLease, {
    connectionId, token, connectedAt: connection.connectedAt, checkpoint: { kind: "recent", through: Date.now() },
  })).toBe(true);
}

async function payerDeal(f: Payments, name: string, meetingAt?: number) {
  const email = `${name}@example.com`;
  const { leadId, opportunityId, meetingId } = await f.t.run(async (ctx) => {
    const leadId = await insertProviderPerson(ctx, f.tenantId, { fullName: name, email });
    await insertProviderIdentifier(ctx, f.tenantId, leadId, "email", email);
    const opportunityId = await insertProviderDeal(ctx, { ...f, leadId, assignedCloserId: f.closerId });
    const meetingId = meetingAt !== undefined
      ? await insertProviderMeeting(ctx, { ...f, opportunityId, scheduledAt: meetingAt })
      : undefined;
    return { leadId, opportunityId, meetingId };
  });
  return { email, leadId, opportunityId, meetingId };
}

async function confirmInBilling(f: Payments, providerPaymentId: Id<"providerPayments">, opportunityId: Id<"opportunities">) {
  const target = { providerPaymentId, opportunityId };
  const { preview, decisionId } = await f.admin.query(api.payments.confirm.previewWhopConfirm, target);
  if (!preview.ok) throw new Error(`Billing preview refused: ${preview.code}`);
  const result = await f.admin.mutation(api.payments.confirm.confirmWhopPayment, {
    ...target, decisionId, expectedAllocationRevision: preview.allocationRevision, expectedFingerprint: preview.fingerprint,
  });
  if (!result.ok) throw new Error(`Billing confirmation refused: ${result.code}`);
  return result.paymentRecordId;
}

async function gradeBlind(
  f: Payments,
  decisionId: Id<"resultAutomationDecisions">,
  knownTarget?: { leadId: Id<"leads">; opportunityId: Id<"opportunities"> },
) {
  const answer = knownTarget ? {
    abstain: false, leadId: knownTarget.leadId, opportunityId: knownTarget.opportunityId,
    amountMinor: 10_000, currency: "USD", paymentType: "pif" as const,
    programId: f.programId, attributedCloserId: f.closerId,
  } : { abstain: false };
  await f.admin.mutation(grading.commitAnswer, { decisionId, answer });
  expect(await f.admin.mutation(grading.reveal, { decisionId })).toMatchObject({ wouldWrite: true });
  await f.admin.mutation(grading.recordGrade, { decisionId, verdict: "correct", wrongFields: [] });
}

it("takes the payment kind from phase-2 controls through certification, automatic writes and a breaker", async () => {
  const f = await automationPaymentFixture({ dealPosition: null, fact: { status: "draft" } });
  const step = scenarioSteps(f);
  const { t, owner, admin, connectionId } = f;
  const kind = "payment_win";
  const mode = async () => (await owner.query(settings.getSettings, {})).effective.payment_win;
  const arrival = async (name: string, withMeeting = false, overrides?: Record<string, unknown>) => {
    const deal = await payerDeal(f, name, withMeeting ? Date.now() + HOUR : undefined);
    const fact = await payFromWhop(f, connectionId, `pay_${name}`, deal.email, overrides);
    return { ...deal, fact };
  };

  await step("phase-2 payment rows work with everything off and no later automation settings", async () => {
    expect(await mode()).toBe("off");
    const { opportunityId, meetingId } = await payerDeal(f, "jules", Date.now() - HOUR);
    if (!meetingId) throw new Error("Missing manual-payment meeting");
    const paymentId = await f.closer.mutation(api.closer.payments.logPayment, {
      opportunityId, meetingId, amount: 100, currency: "USD", programId: f.programId,
      paymentType: "pif", proofFileId: await storeProofFile(t),
    });
    expect(await t.run((ctx) => ctx.db.get("paymentRecords", paymentId)))
      .toMatchObject({ recordedByUserId: f.closerId, amountMinor: 10_000 });
    expect(await t.run((ctx) => ctx.db.query("resultAutomationDecisions").take(1))).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("automationSamples").take(1))).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("callInsightRuns").take(1))).toEqual([]);
  });

  const oldAsk = await step("phase-2 one-tap asks can be confirmed while there is no certificate", async () => {
    await owner.mutation(settings.setEnabled, { enabled: true });
    await owner.mutation(settings.setKindMode, { kind, mode: "ask" });
    const accepted = await arrival("sage");
    const pending = await arrival("milo");
    await runImmediateWork(f);
    const picked = await paymentDecision(f, accepted.fact._id, "ready");
    const unworked = await paymentDecision(f, pending.fact._id, "ready");
    expect(picked).toMatchObject({ mode: "ask", state: "ready", wouldWrite: true });
    if (!unworked) throw new Error("Missing outstanding phase-2 ask");
    const paymentId = await confirmInBilling(f, accepted.fact._id, accepted.opportunityId);
    expect(await paymentDecision(f, accepted.fact._id, "applied")).toMatchObject({ mode: "ask", appliedPaymentRecordId: paymentId });
    return unworked;
  });

  await step("an admin pauses automation and the owner resumes without restarting the old ask", async () => {
    await admin.mutation(settings.setEnabled, { enabled: false });
    expect(await mode()).toBe("off");
    expect(await decision(f, oldAsk._id)).toMatchObject({ state: "stopped", stopCode: "paused" });
    await owner.mutation(settings.setEnabled, { enabled: true });
    expect(await mode()).toBe("ask");
    await runImmediateWork(f);
    expect(await decision(f, oldAsk._id)).toMatchObject({ state: "stopped", stopCode: "paused" });
    expect(await paymentDecision(f, oldAsk.providerPaymentId!, "ready")).toBeNull();
  });

  const firstSampleCase = await step("the owner switches to shadow and 299 distinct eligible payment decisions accumulate", async () => {
    await admin.mutation(settings.setKindMode, { kind, mode: "shadow" });
    await owner.mutation(settings.setGrader, { userId: f.adminId });
    expect(await mode()).toBe("shadow");
    const first = await arrival("arden");
    await runImmediateWork(f);
    const row = await paymentDecision(f, first.fact._id, "shadow");
    expect(row).toMatchObject({ state: "shadow", mode: "shadow", wouldWrite: true });
    if (!row) throw new Error("Missing shadow decision");
    // Seed ungraded, unenrolled eligible cases below the invariant checkers'
    // deal and provider-fact limits. Opening the sample still counts them.
    for (let offset = 0; offset < 298; offset += 100) {
      await t.run(async (ctx) => {
        for (let i = offset; i < Math.min(offset + 100, 298); i++) {
          const leadId = await insertProviderPerson(ctx, f.tenantId, { email: `sample-${i}@example.com` });
          await seedReadyDecision(ctx, {
            tenantId: f.tenantId, leadId, kind, inputKey: await sha256Hex(`payment sample ${leadId}`),
            ruleVersion: row.ruleVersion, policyVersion: row.policyVersion,
            activationVersion: row.activationVersion, createdAt: Date.now(), evidence: row.evidence,
          });
        }
      });
    }
    return { decisionId: row._id, target: first };
  });

  const { sampleId, memberIds } = await step("the owner opens a sample and the grader sees evidence before a proposal", async () => {
    const sampleId = await owner.mutation(certificates.openSample, { kind });
    if (!sampleId) throw new Error("Owner could not open the sample");
    await runImmediateWork(f);
    const progress = await owner.query(certificates.getSampleProgress, { sampleId });
    expect(progress).toMatchObject({ members: 299, distinctPeople: 299, target: 300, status: "collecting" });
    const memberIds = await t.run(async (ctx) => (await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_sampleId_and_leadId", (q) => q.eq("tenantId", f.tenantId).eq("sampleId", sampleId))
      .take(300)).map((row) => row._id));
    expect(memberIds).toContain(firstSampleCase.decisionId);
    const { cases } = await admin.query(grading.listToGrade, { kind, sample: "writes" });
    const blindCase = cases.find((item) => item.decisionId === firstSampleCase.decisionId);
    expect(blindCase).toMatchObject({ answerCommitted: false, evidence: expect.any(Object) });
    expect(blindCase).not.toHaveProperty("proposal");
    expect(blindCase).not.toHaveProperty("wouldWrite");
    return { sampleId, memberIds };
  });

  await step("299 correct blind grades still cannot certify", async () => {
    const { decisionId, target } = firstSampleCase;
    await gradeBlind(f, decisionId, target);
    expect(await admin.query(grading.getMyAnswer, { decisionId })).toMatchObject({ blind: true });
    for (const id of memberIds.filter((id) => id !== decisionId)) await gradeBlind(f, id);
    expect(await decision(f, decisionId)).toMatchObject({
      grade: { verdict: "correct", gradedBeforeSeeing: true, gradedByUserId: f.adminId },
    });
    expect(await owner.query(certificates.getSampleProgress, { sampleId })).toMatchObject({
      members: 299, correct: 299, exposed: 0, target: 300, status: "collecting",
    });
    expect(await owner.mutation(certificates.certify, { sampleId })).toEqual({ ok: false, code: "not_full" });
  });

  await step("the 300th eligible person fills and certifies the sample", async () => {
    const last = await arrival("case-three-hundred");
    await runImmediateWork(f);
    const row = await paymentDecision(f, last.fact._id, "shadow");
    if (!row) throw new Error("Missing the 300th shadow decision");
    expect(row.sampleId).toBe(sampleId);
    await gradeBlind(f, row._id, last);
    expect(await owner.query(certificates.getSampleProgress, { sampleId })).toMatchObject({
      members: 300, distinctPeople: 300, correct: 300, exposed: 0, status: "full",
    });
    expect(await owner.mutation(certificates.certify, { sampleId })).toEqual({ ok: true });
    expect(await owner.query(certificates.getSampleProgress, { sampleId })).toMatchObject({
      status: "certified", scopeBindingIds: expect.arrayContaining([f.productBindingId, f.variantBindingId]),
    });
  });

  await step("an admin cannot promote the certificate and the owner can", async () => {
    await expect(admin.mutation(certificates.promoteKind, { kind, sampleId })).rejects.toThrow("Insufficient permissions");
    expect(await mode()).toBe("shadow");
    expect(await owner.mutation(certificates.promoteKind, { kind, sampleId })).toEqual({ ok: true, alreadyApplied: false, sampleId });
    expect(await mode()).toBe("automatic");
  });

  const firstWin = await step("a first payment waits the full 15 minutes without recording cash or attendance", async () => {
    await freshWhopSweep(f, connectionId);
    const win = await arrival("robin", true, { membership_id: MEMBERSHIP });
    await runImmediateWork(f);
    const row = await paymentDecision(f, win.fact._id, "ready");
    expect(row).toMatchObject({ kind, mode: "automatic", state: "ready", wouldWrite: true });
    if (!row || row.dueAt === undefined || !win.meetingId) throw new Error("Missing automatic deadline or meeting");
    expect(row.dueAt - row.createdAt).toBe(15 * 60_000);
    await advanceTo(f, row.dueAt - 1);
    expect(await decision(f, row._id)).toMatchObject({ state: "ready" });
    expect((await t.run((ctx) => ctx.db.get("providerPayments", win.fact._id)))?.paymentRecordId).toBeUndefined();
    const meeting = await t.run((ctx) => ctx.db.get("meetings", win.meetingId!));
    expect(meeting).toMatchObject({ status: "scheduled" });
    expect(meeting?.attendanceOwedSince).toBeUndefined();
    return { ...win, decisionId: row._id, dueAt: row.dueAt, meetingId: win.meetingId };
  });

  const firstPaymentId = await step("the scheduled write wins the deal without a recorder and leaves attendance owed", async () => {
    await advanceTo(f, firstWin.dueAt);
    const receipt = await decision(f, firstWin.decisionId);
    expect(receipt).toMatchObject({
      state: "applied", certificateSampleId: sampleId, appliedVia: "automatic", resolvedAt: firstWin.dueAt, auditReason: "canary",
    });
    expect(receipt?.resolvedByUserId).toBeUndefined();
    if (!receipt?.appliedPaymentRecordId) throw new Error("Automatic receipt has no payment");
    const payment = await t.run((ctx) => ctx.db.get("paymentRecords", receipt.appliedPaymentRecordId!));
    expect(payment).toMatchObject({ origin: "provider", amountMinor: 10_000, automationDecisionId: firstWin.decisionId });
    expect(payment?.recordedByUserId).toBeUndefined();
    const meeting = await t.run((ctx) => ctx.db.get("meetings", firstWin.meetingId));
    expect(meeting).toMatchObject({ status: "scheduled" });
    if (!meeting) throw new Error("Missing first-payment meeting");
    expect(meeting.attendanceOwedSince).toBe(meeting.scheduledAt + meeting.durationMinutes * 60_000);
    expect(meeting.heldMarkedAt).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.get("opportunities", firstWin.opportunityId)))
      .toMatchObject({ outcome: "won", paymentReceivedAt: firstWin.dueAt });
    return receipt.appliedPaymentRecordId;
  });

  const canaryIds = [firstWin.decisionId];
  for (let i = 2; i <= 10; i++) {
    await step(`automatic win ${i} writes and opens a canary audit`, async () => {
      await freshWhopSweep(f, connectionId);
      const win = await arrival(`canary-${i}`);
      await runImmediateWork(f);
      const ready = await paymentDecision(f, win.fact._id, "ready");
      if (!ready?.dueAt) throw new Error("Canary has no automatic deadline");
      await advanceTo(f, ready.dueAt);
      expect(await decision(f, ready._id)).toMatchObject({
        state: "applied", auditReason: "canary", auditOpenDueAt: expect.any(Number),
      });
      canaryIds.push(ready._id);
    });
  }

  await step("the first ten wins are all queued and a wrong-person audit trips the breaker", async () => {
    const { cases } = await admin.query(audit.listAuditQueue, { kind });
    expect(cases).toHaveLength(10);
    expect(new Set(cases.map((row) => row.decisionId))).toEqual(new Set(canaryIds));
    expect(cases.every((row) => row.reason === "canary" && row.dueAt > Date.now())).toBe(true);
    expect(await admin.mutation(audit.recordAudit, {
      decisionId: firstWin.decisionId, verdict: "wrong", wrongFields: ["person"],
    })).toMatchObject({ ok: true });
    expect(await owner.query(settings.getSettings, {})).toMatchObject({
      effective: { payment_win: "ask" }, breakers: [{ kind, reason: "wrong_write", decisionId: firstWin.decisionId }],
    });
  });

  await step("the breaker turns the next matched Whop payment into a one-tap ask", async () => {
    const win = await arrival("teagan");
    await runImmediateWork(f);
    const row = await paymentDecision(f, win.fact._id, "ready");
    expect(row).toMatchObject({ mode: "ask", wouldWrite: true });
    expect(row?.dueAt).toBeUndefined();
    expect((await admin.query(api.payments.confirm.previewWhopConfirm, {
      providerPaymentId: win.fact._id, opportunityId: win.opportunityId,
    })).decisionId).toBe(row?._id);
    await advanceTo(f, Date.now() + AUTOMATIC_WIN_GRACE_MS);
    expect(await paymentDecision(f, win.fact._id, "applied")).toBeNull();
    expect(await t.run((ctx) => ctx.db.get("opportunities", win.opportunityId))).toMatchObject({ outcome: "open" });
  });

  await step("the owner resets the breaker and restores the certified automatic level", async () => {
    expect(await owner.mutation(breaker.resetBreaker, { kind })).toEqual({ ok: true, alreadyApplied: false });
    expect(await owner.query(settings.getSettings, {})).toMatchObject({ effective: { payment_win: "automatic" }, breakers: [] });
  });

  await step("a new payment rule version lapses the certificate and returns the kind to ask", async () => {
    // A code deploy changes the serving version. The old certificate and its
    // applied receipts stay in place so their recorded provenance still checks.
    const tenant = await t.run((ctx) => ctx.db.get("tenants", f.tenantId));
    if (!tenant) throw new Error("Missing tenant");
    const previous = currentRuleVersion(tenant, kind);
    rule.version = `payment-rule@${Number(previous.split("@")[1]) + 1}`;
    expect(await owner.query(settings.getSettings, {})).toMatchObject({
      effective: { payment_win: "ask" },
      automatic: { payment_win: { sampleId, certificateState: "lapsed", automaticBlockedReason: "certificate_lapsed" } },
    });
    expect(await owner.mutation(breaker.resetBreaker, { kind })).toMatchObject({ ok: false, code: "certificate_lapsed" });
  });

  const { bindingId, laterSampleId } = await step("a confirmed membership is anchored to the first counting payment", async () => {
    const bindingId = await t.run((ctx) => insertProviderBinding(ctx, {
      ...f, externalId: MEMBERSHIP,
      binding: {
        kind: "membership_deal", leadId: firstWin.leadId, opportunityId: firstWin.opportunityId,
        anchorPaymentRecordId: firstPaymentId,
      },
    }));
    const tenant = await t.run((ctx) => ctx.db.get("tenants", f.tenantId));
    if (!tenant) throw new Error("Missing tenant");
    const laterSampleId = await seedAutomaticCertificate(t, {
      tenantId: f.tenantId, promotedByUserId: f.ownerId, kind: "additional_payment",
      ruleVersion: currentRuleVersion(tenant, "additional_payment"), scopeBindingIds: [bindingId, f.productBindingId, f.variantBindingId],
      now: Date.now(),
    });
    return { bindingId, laterSampleId };
  });

  await step("a later membership payment is due immediately and never wins the deal a second time", async () => {
    await freshWhopSweep(f, connectionId);
    const fact = await payFromWhop(f, connectionId, "pay_auto_installment", "different-payer@example.com", {
      membership_id: MEMBERSHIP, billing_reason: "subscription_cycle",
      total: { amount: "40.00", currency: "usd", decimals: 2 },
    });
    await runImmediateWork(f);
    const receipt = await paymentDecision(f, fact._id, "applied");
    expect(receipt).toMatchObject({
      kind: "additional_payment", mode: "automatic", opportunityId: firstWin.opportunityId, certificateSampleId: laterSampleId,
      evidence: { bindingIds: expect.arrayContaining([bindingId]) },
    });
    expect(receipt?.dueAt).toBe(receipt?.createdAt);
    expect((receipt?.resolvedAt ?? 0) - (receipt?.createdAt ?? 0)).toBeLessThanOrEqual(5);
    const [deal, payments, wins] = await t.run(async (ctx) => [
      await ctx.db.get("opportunities", firstWin.opportunityId),
      await ctx.db.query("paymentRecords").withIndex("by_opportunityId_and_recordedAt", (q) =>
        q.eq("opportunityId", firstWin.opportunityId)).take(3),
      (await ctx.db.query("domainEvents").withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
        q.eq("tenantId", f.tenantId).eq("entityType", "opportunity").eq("entityId", firstWin.opportunityId)).take(30))
        .filter((event) => event.eventType === "opportunity.stage_changed" && JSON.parse(event.metadata ?? "{}").toOutcome === "won"),
    ] as const);
    expect(deal).toMatchObject({ outcome: "won", paymentReceivedAt: firstWin.dueAt });
    expect(wins).toHaveLength(1);
    expect(payments).toMatchObject([
      { _id: firstPaymentId, amountMinor: 10_000 }, { amountMinor: 4_000, providerPaymentId: fact._id, origin: "provider" },
    ]);
    expect(payments[1]?.recordedByUserId).toBeUndefined();
  });
}, 120_000);

async function anotherCall(f: Call, name: string): Promise<Call> {
  const ids = await f.t.run(async (ctx) => {
    const email = `${name}@example.com`;
    const leadId = await insertProviderPerson(ctx, f.tenantId, { fullName: name, email });
    const opportunityId = await insertProviderDeal(ctx, { ...f, leadId, assignedCloserId: f.closerId });
    const scheduledAt = Date.now() - HOUR;
    const meetingId = await insertProviderMeeting(ctx, { ...f, opportunityId, scheduledAt });
    const deal = (await ctx.db.get("opportunities", opportunityId))!;
    await ctx.db.patch("opportunities", opportunityId, { latestActivityAt: computeLatestActivityAt(deal) });
    const recordingId = await seedReadablePaymentRecording(ctx, { ...f, meetingId });
    await ctx.db.patch("callRecordings", recordingId, {
      matchMethod: "time_email", inviteeEmails: [email], recordingStartAt: scheduledAt,
      recordingEndAt: scheduledAt + HOUR / 2,
    });
    return { opportunityId, meetingId, recordingId, leadId };
  });
  return { ...f, ...ids };
}

function callDecisions(call: Call) {
  return call.t.run((ctx) => ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_meetingId", (q) => q.eq("tenantId", call.tenantId).eq("meetingId", call.meetingId)).take(10));
}

async function publish(call: Call, options: Parameters<typeof seedCallDecisionReading>[1]) {
  await call.t.mutation(internal.callInsights.run.publish, await seedCallDecisionReading(call, options));
  await runImmediateWork(call);
}

async function applyCallBack(call: Call, sampleId: Id<"automationSamples">) {
  const before = await call.t.run((ctx) => ctx.db.get("opportunities", call.opportunityId));
  if (before?.latestActivityAt === undefined) throw new Error("The booked fixture needs a stored activity clock");
  await publish(call, { kind: "call_back" });
  const [row] = await callDecisions(call);
  expect(row).toMatchObject({ kind: "call_back", state: "applied", mode: "automatic", certificateSampleId: sampleId });
  expect(row?.resolvedByUserId).toBeUndefined();
  if (!row?.writtenFollowUpId) throw new Error("The scheduled call evaluation did not leave a task");
  const { meeting, followUp, deal, checks } = await call.t.run(async (ctx) => ({
    meeting: await ctx.db.get("meetings", call.meetingId),
    followUp: await ctx.db.get("followUps", row.writtenFollowUpId!),
    deal: await ctx.db.get("opportunities", call.opportunityId),
    checks: await ctx.db.query("secondOpinions").take(5),
  }));
  expect(meeting).toMatchObject({ status: "held", attendanceSource: "call_insights", attendanceDecisionId: row._id });
  expect(deal).toMatchObject({ stage: "follow_up", outcome: "open" });
  expect(deal?.latestActivityAt).toBe(before?.latestActivityAt);
  expect(deal?.humanResultRevision).toBe(before?.humanResultRevision);
  expect(followUp).toMatchObject({ status: "pending", purpose: "call_back", createdSource: "system" });
  expect(followUp?.createdByUserId).toBeUndefined();
  expect(checks).toEqual([]);
  return { decisionId: row._id, followUpId: row.writtenFollowUpId };
}

it("automatically records call-backs, offers both attendance answers on Undo, and protects a human edit", async () => {
  const f = await callTaskFixture("call_back", true);
  if (!f.sampleId) throw new Error("Missing call-back certificate");
  const sampleId = f.sampleId;
  const step = scenarioSteps(f);
  await step("call-back is promoted on a full certificate", async () => {
    await f.t.run(async (ctx) => {
      const deal = (await ctx.db.get("opportunities", f.opportunityId))!;
      await ctx.db.patch("opportunities", deal._id, { latestActivityAt: computeLatestActivityAt(deal) });
    });
    expect(await f.owner.query(settings.getSettings, {})).toMatchObject({
      callEffective: { call_back: "automatic" }, automatic: { call_back: { sampleId, certificateState: "certified" } },
    });
  });

  const first = await step("a reading sets the task and records Held without a person or Second opinion", () =>
    applyCallBack(f, sampleId));
  await step("the closer undoes the task and says the call happened", async () => {
    expect(await f.closer.mutation(undo.undoAutomaticWrite, {
      decisionId: first.decisionId, callHappened: true,
    })).toEqual({ ok: true, alreadyApplied: false });
    expect(await decision(f, first.decisionId)).toMatchObject({ state: "undone" });
    expect(await f.t.run((ctx) => ctx.db.get("followUps", first.followUpId))).toMatchObject({ status: "expired" });
    expect(await f.t.run((ctx) => ctx.db.get("meetings", f.meetingId))).toMatchObject({
      status: "held", attendanceDecisionId: first.decisionId,
    });
  });

  const second = await step("a separate booked deal gets its own automatic call-back", async () => {
    const call = await anotherCall(f, "avery");
    return { call, ...await applyCallBack(call, sampleId) };
  });
  await step("an admin undoes that result and says the call did not happen", async () => {
    expect(await f.admin.mutation(undo.undoAutomaticWrite, {
      decisionId: second.decisionId, callHappened: false,
    })).toEqual({ ok: true, alreadyApplied: false });
    expect(await decision(f, second.decisionId)).toMatchObject({ state: "undone" });
    expect(await f.t.run((ctx) => ctx.db.get("followUps", second.followUpId))).toMatchObject({ status: "expired" });
    const meeting = await f.t.run((ctx) => ctx.db.get("meetings", second.call.meetingId));
    expect(meeting).toMatchObject({ status: "scheduled" });
    expect(meeting?.heldMarkedAt).toBeUndefined();
    expect(meeting?.attendanceDecisionId).toBeUndefined();
    expect(await f.t.run((ctx) => ctx.db.get("opportunities", second.call.opportunityId)))
      .toMatchObject({ stage: "booked", outcome: "open" });
  });

  const third = await step("a third reading sets an automatic call-back", async () => {
    const call = await anotherCall(f, "taylor");
    return { call, ...await applyCallBack(call, sampleId) };
  });
  const replacementId = await step("the closer changes the next step on the third call-back", async () => {
    const edit = await f.closer.mutation(taskCorrections.changeNextStep, {
      decisionId: third.decisionId, contactMethod: "text", reminderScheduledAt: Date.now() + HOUR,
    });
    if (!edit.ok) throw new Error(`Change refused: ${edit.code}`);
    expect(await f.t.run((ctx) => ctx.db.get("followUps", third.followUpId))).toMatchObject({ status: "expired" });
    return edit.followUpId;
  });
  await step("Undo refuses to overwrite the closer's edited task", async () => {
    expect(await f.closer.mutation(undo.undoAutomaticWrite, {
      decisionId: third.decisionId, callHappened: true,
    })).toMatchObject({ ok: false, code: "not_ready" });
    expect(await f.t.run((ctx) => ctx.db.get("followUps", replacementId)))
      .toMatchObject({ status: "pending", contactMethod: "text", createdByUserId: f.closerId });
    expect(await f.t.run((ctx) => ctx.db.get("meetings", third.call.meetingId))).toMatchObject({ status: "held" });
  });
});

it("waits for refusal acknowledgment, cancels on a payment, then closes and reopens a separate refusal", async () => {
  const f = await callInsightsHarness({ settings: { mode: "on" } });
  const { t, tenantId, owner, closer } = f;
  const step = scenarioSteps(f);
  const { sampleId, connectionId } = await step("the owner has a current refusal certificate and a connected Whop account", async () => {
    const connectionId = await t.run(async (ctx) => {
      await insertMeetingAggregate(ctx, f.meetingId);
      await insertOpportunityAggregate(ctx, f.opportunityId);
      await insertProviderIdentifier(ctx, tenantId, f.leadId, "email", "grace@example.com");
      return insertPaymentFixtureConnection(ctx, tenantId, f.adminId);
    });
    await owner.mutation(settings.setEnabled, { enabled: true });
    const tenant = await t.run((ctx) => ctx.db.get("tenants", tenantId));
    if (!tenant) throw new Error("Missing tenant");
    const sampleId = await seedAutomaticCertificate(t, {
      tenantId, promotedByUserId: f.ownerId, kind: "refusal_loss",
      ruleVersion: currentRuleVersion(tenant, "refusal_loss"), now: Date.now(),
    });
    return { sampleId, connectionId };
  });

  async function openNotice(call: Call) {
    await publish(call, { kind: "refusal_loss" });
    const [row] = await callDecisions(call);
    expect(row).toMatchObject({ kind: "refusal_loss", state: "notice", mode: "automatic", noticeUserId: f.closerId });
    if (!row) throw new Error("Refusal reading did not raise a notice");
    expect(row.dueAt).toBeUndefined();
    return row._id;
  }

  async function acknowledge(decisionId: Id<"resultAutomationDecisions">) {
    const acknowledgedAt = Date.now();
    const dueAt = acknowledgedAt + 48 * HOUR;
    expect(await closer.mutation(notice.acknowledgeNotice, { decisionId })).toEqual({ ok: true, alreadyApplied: false });
    expect(await decision(f, decisionId)).toMatchObject({ state: "notice", acknowledgedAt, dueAt, acknowledgedByUserId: f.closerId });
    return dueAt;
  }

  const first = await step("the first reading raises an unacknowledged notice", () => openNotice(f));
  await step("60 hours without acknowledgment leave the deal open and the meeting scheduled", async () => {
    await advanceTo(f, Date.now() + 60 * HOUR);
    expect(await decision(f, first)).toMatchObject({ state: "notice" });
    expect((await decision(f, first))?.acknowledgedAt).toBeUndefined();
    expect((await decision(f, first))?.dueAt).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.get("opportunities", f.opportunityId))).toMatchObject({ outcome: "open" });
    expect(await t.run((ctx) => ctx.db.get("meetings", f.meetingId))).toMatchObject({ status: "scheduled" });
  });
  const due = await step("the closer acknowledges and starts the 48-hour period", () => acknowledge(first));

  await step("Whop arrives at hour 20 and cancels the notice while the deal is still open", async () => {
    await advanceTo(f, due - 28 * HOUR);
    const fact = await payFromWhop(f, connectionId, "pay_after_notice", "grace@example.com");
    await runImmediateWork(f);
    expect(fact).toMatchObject({ candidateLeadId: f.leadId });
    expect(fact.paymentRecordId).toBeUndefined();
    expect(await decision(f, first)).toMatchObject({ state: "stopped", stopCode: "payment_found" });
    expect(await t.run((ctx) => ctx.db.get("opportunities", f.opportunityId))).toMatchObject({ outcome: "open" });
  });

  const second = await step("a second deal gets its own refusal notice", async () => {
    const call = await anotherCall(f, "reese");
    return { call, decisionId: await openNotice(call) };
  });
  const secondDueAt = await step("the closer acknowledges the second notice", () => acknowledge(second.decisionId));

  await step("both deals are still open one millisecond before the second deadline", async () => {
    await advanceTo(f, secondDueAt - 1);
    await freshWhopSweep(f, connectionId);
    expect(await decision(f, first)).toMatchObject({ state: "stopped", stopCode: "payment_found" });
    expect(await decision(f, second.decisionId)).toMatchObject({ state: "notice" });
    for (const call of [f, second.call]) {
      expect(await t.run((ctx) => ctx.db.get("opportunities", call.opportunityId))).toMatchObject({ outcome: "open" });
      expect(await t.run((ctx) => ctx.db.get("meetings", call.meetingId))).toMatchObject({ status: "scheduled" });
    }
  });

  const range = { startDate: FIXTURE_NOW - 2 * HOUR, endDate: secondDueAt + HOUR };
  await step("the second deadline records a refusal without a person and credits the closer's loss", async () => {
    await advanceTo(f, secondDueAt);
    const row = await decision(f, second.decisionId);
    expect(row).toMatchObject({ state: "applied", certificateSampleId: sampleId, resolvedAt: secondDueAt });
    expect(row?.resolvedByUserId).toBeUndefined();
    const deal = await t.run((ctx) => ctx.db.get("opportunities", second.call.opportunityId));
    expect(deal).toMatchObject({ stage: "closed", outcome: "lost", lostReason: "call_refusal", lostAt: secondDueAt });
    expect(deal?.lostByUserId).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.get("meetings", second.call.meetingId)))
      .toMatchObject({ status: "held", attendanceDecisionId: second.decisionId });
    expect((await closer.query(api.closer.dashboard.getPipelineSummary, range)).decided).toEqual({ lost: 1, won: 0 });
  });

  await step("the closer reopens to Follow-up with a reminder due now and the meeting stays held", async () => {
    const result = await closer.mutation(refusal.reopenRefusal, { decisionId: second.decisionId });
    if (!result.ok) throw new Error(`Reopen refused: ${result.code}`);
    expect(await t.run((ctx) => ctx.db.get("opportunities", second.call.opportunityId)))
      .toMatchObject({ stage: "follow_up", outcome: "open" });
    expect(await t.run((ctx) => ctx.db.query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) =>
        q.eq("opportunityId", second.call.opportunityId).eq("status", "pending")).take(3)))
      .toMatchObject([{ status: "pending", reminderScheduledAt: Date.now(), closerId: f.closerId }]);
    expect(await t.run((ctx) => ctx.db.get("meetings", second.call.meetingId)))
      .toMatchObject({ status: "held", heldMarkedAt: secondDueAt });
    expect((await closer.query(api.closer.dashboard.getPipelineSummary, range)).decided).toEqual({ lost: 0, won: 0 });
  });

  await step("reading the reopened call again cannot raise a second notice", async () => {
    await publish(second.call, { kind: "refusal_loss", generation: 2, trigger: "read_again" });
    const rows = await callDecisions(second.call);
    expect(rows.filter((row) => row.state === "notice")).toEqual([]);
    expect(rows.filter((row) => row.noticeRound !== undefined).map((row) => row._id)).toEqual([second.decisionId]);
    expect(await t.run((ctx) => ctx.db.get("opportunities", second.call.opportunityId))).toMatchObject({ outcome: "open" });
  });
});
