import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertAutomationInvariants } from "../../../tests/automationInvariants";
import { callInsightsHarness, seedCallDecisionReading } from "../../../tests/callInsightsHarness";
import { insertProgram } from "../../../tests/enrollmentFixtures";
import { assertPaymentInvariants } from "../../../tests/paymentInvariants";
import {
  FIXTURE_NOW, PRODUCT_ID, VARIANT_ID, insertPaymentFixtureConnection, insertProviderBinding,
  insertProviderDeal, insertProviderIdentifier, insertProviderMeeting, insertProviderPerson,
  seedReadablePaymentRecording,
} from "../../../tests/providerPaymentFixtures";
import { iso, paymentFixture } from "../../../tests/whopFixtures";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { normalizePayment, paymentSchema } from "../../payments/whop/normalize";
import { insertMeetingAggregate, insertOpportunityAggregate } from "../../reporting/writeHooks";

const HOUR = 3_600_000;
const PROSPECT = "grace@example.com";
const { confirmCall, settings, taskCorrections } = api.automation;
type Call = Awaited<ReturnType<typeof callInsightsHarness>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function scenarioSteps({ t, tenantId }: Call) {
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

async function anotherCall(f: Call, name: string, leadId?: Id<"leads">): Promise<Call> {
  const email = `${name.toLowerCase()}@example.com`;
  const ids = await f.t.run(async (ctx) => {
    const person = leadId ?? await insertProviderPerson(ctx, f.tenantId, { fullName: name, email });
    const opportunityId = await insertProviderDeal(ctx, { ...f, leadId: person, assignedCloserId: f.closerId });
    const meetingId = await insertProviderMeeting(ctx, { ...f, opportunityId, scheduledAt: Date.now() - HOUR });
    const recordingId = await seedReadablePaymentRecording(ctx, { ...f, meetingId });
    await ctx.db.patch("callRecordings", recordingId, { matchMethod: "time_email", inviteeEmails: [email] });
    return { leadId: person, opportunityId, meetingId, recordingId };
  });
  return { ...f, ...ids };
}

async function publish(call: Call, options: Parameters<typeof seedCallDecisionReading>[1]) {
  const reading = await seedCallDecisionReading(call, options);
  await call.t.mutation(internal.callInsights.run.publish, reading);
  await call.t.finishAllScheduledFunctions(vi.runAllTimers);
  return reading.runId;
}

async function askFor(call: Call) {
  const ask = await call.closer.query(confirmCall.getCallAsk, { meetingId: call.meetingId });
  if (!ask) throw new Error("The closer has no call proposal");
  return ask;
}

async function confirmTask(call: Call, ask: Awaited<ReturnType<typeof askFor>>) {
  const result = await call.closer.mutation(confirmCall.confirmCallDecision, {
    decisionId: ask.decisionId, expectedInputKey: ask.expectedInputKey,
  });
  if (!result.ok) throw new Error(`Call confirmation refused: ${result.code}`);
  return result.followUpId;
}

async function cancelSecondOpinionWorkers({ t }: Call) {
  // Keep the queue rows so we can inspect them without dispatching the model action.
  await t.run(async (ctx) => {
    const jobs = (await ctx.db.system.query("_scheduled_functions").take(100))
      .filter((job) => job.name === "secondOpinion/run:run" && job.state.kind === "pending");
    expect(jobs).toHaveLength(1);
    await ctx.scheduler.cancel(jobs[0]._id);
  });
}

function callState(call: Call) {
  return call.t.run(async (ctx) => ({
    deal: await ctx.db.get("opportunities", call.opportunityId),
    meeting: await ctx.db.get("meetings", call.meetingId),
    person: await ctx.db.get("leads", call.leadId),
    tasks: await ctx.db.query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) => q.eq("opportunityId", call.opportunityId)).take(10),
    pending: await ctx.db.query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) => q.eq("opportunityId", call.opportunityId).eq("status", "pending")).take(10),
  }));
}

async function receiveWhopPayment(f: Call, connectionId: Id<"tenantPaymentConnections">) {
  const connection = await f.t.run((ctx) => ctx.db.get("tenantPaymentConnections", connectionId));
  if (!connection) throw new Error("Missing Whop connection fixture");
  const externalPaymentId = "pay_grace_promise";
  const identity = { connectionId, connectedAt: connection.connectedAt, accountId: connection.accountId, externalPaymentId };
  const generation = await f.t.mutation(internal.payments.intake.beginPaymentRead, identity);
  if (generation === null) throw new Error("Whop read did not start");
  const now = iso(Date.now());
  const payment = normalizePayment(paymentSchema.parse(paymentFixture({
    id: externalPaymentId, account_id: connection.accountId,
    created_at: now, updated_at: now, paid_at: now, customer_email: PROSPECT, customer_phone: null,
    product_id: PRODUCT_ID, variant_id: VARIANT_ID, billing_reason: "one_time",
    total: { amount: "225.00", currency: "usd", decimals: 2 },
  })));
  expect(await f.t.mutation(internal.payments.intake.storePaymentRead, { ...identity, generation, payment })).toBe("stored");
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  const fact = await f.t.run((ctx) => ctx.db.query("providerPayments")
    .withIndex("by_tenantId_and_connectionId_and_externalPaymentId", (q) =>
      q.eq("tenantId", f.tenantId).eq("connectionId", connectionId).eq("externalPaymentId", externalPaymentId)).unique());
  if (!fact) throw new Error("Whop did not store the payment");
  return fact;
}

it("works a promised payment through correction, then corrects and vetoes call-back results", async () => {
  const f = await callInsightsHarness({ settings: null });
  const step = scenarioSteps(f);
  const { t, owner, closer, admin, tenantId, adminId, leadId, opportunityId, meetingId, recordingId } = f;
  const { connectionId, programId } = await step("start with one booked meeting and no automation settings", async () => {
    const ids = await t.run(async (ctx) => {
      await ctx.db.patch("opportunities", opportunityId, { latestMeetingId: meetingId, latestMeetingAt: FIXTURE_NOW - 2 * HOUR });
      await ctx.db.patch("tenants", tenantId, { billingOpsEnabled: true });
      await insertOpportunityAggregate(ctx, opportunityId);
      await insertMeetingAggregate(ctx, meetingId);
      await insertProviderIdentifier(ctx, tenantId, leadId, "email", PROSPECT);
      const programId = await insertProgram(ctx, tenantId, "Field coaching");
      const connectionId = await insertPaymentFixtureConnection(ctx, tenantId, adminId);
      await insertProviderBinding(ctx, {
        tenantId, adminId, connectionId, externalId: PRODUCT_ID, binding: { kind: "product_program", programId },
      });
      await insertProviderBinding(ctx, {
        tenantId, adminId, connectionId, externalId: VARIANT_ID, binding: { kind: "variant_type", paymentType: "pif" },
      });
      return { connectionId, programId };
    });
    expect((await owner.query(settings.getSettings, {})).configured).toBeNull();
    return ids;
  });

  await step("the owner enables Call insights and one-tap call and payment results", async () => {
    await owner.mutation(api.callInsights.admin.enable, {});
    await owner.mutation(api.callInsights.admin.updateSettings, { mode: "on", suggestions: "on" });
    await owner.mutation(settings.setEnabled, { enabled: true });
    await owner.mutation(settings.setKindMode, { kind: "call_back", mode: "ask" });
    await owner.mutation(settings.setKindMode, { kind: "payment_owed", mode: "ask" });
    await owner.mutation(settings.setKindMode, { kind: "payment_win", mode: "ask" });
    expect(await owner.query(settings.getSettings, {})).toMatchObject({
      callEffective: { call_back: "ask", payment_owed: "ask" }, effective: { payment_win: "ask" },
    });
  });

  const promisedPaymentAt = Date.now() + 48 * HOUR;
  const promise = { expectedAmountMinor: 25_000, expectedCurrency: "USD", promisedPaymentAt };
  const ask = await step("publishing a clear payment promise offers one tap and writes no task", async () => {
    await publish(f, { kind: "payment_owed" });
    const result = await askFor(f);
    expect(result).toMatchObject({ kind: "payment_owed", state: "ready", proposal: { ...promise } });
    expect(await callState(f)).toMatchObject({ meeting: { status: "scheduled" }, tasks: [] });
    return result;
  });

  const taskId = await step("the closer confirms payment owed, records Held and queues Second opinion", async () => {
    const followUpId = await confirmTask(f, ask);
    expect(await callState(f)).toMatchObject({
      deal: { stage: "follow_up", outcome: "open" },
      meeting: { status: "held", attendanceSource: "call_insights", attendanceDecisionId: ask.decisionId },
      pending: [{
        _id: followUpId, purpose: "payment_owed", sourceMeetingId: meetingId, createdByUserId: f.closerId,
        reminderScheduledAt: promisedPaymentAt, ...promise,
      }],
    });
    expect(await t.run((ctx) => ctx.db.query("secondOpinions").take(2))).toMatchObject([{
      meetingId, recordingId, status: "queued", trigger: "result_recorded", record: { kind: "call_back" },
    }]);
    await cancelSecondOpinionWorkers(f);
    return followUpId;
  });

  const arrival = await step("Whop sends $225 for the person and the reminder shows a payment ask", async () => {
    const fact = await receiveWhopPayment(f, connectionId);
    expect(fact).toMatchObject({ candidateLeadId: leadId, candidateOpportunityId: opportunityId, totalMinor: 22_500 });
    expect(fact.paymentRecordId).toBeUndefined();
    const result = await closer.query(api.payments.confirm.getWhopAsk, { target: { kind: "reminder", followUpId: taskId } });
    expect(result).toMatchObject({ providerPaymentId: fact._id, opportunityId, recordsAutomaticallyAt: null });
    expect((await callState(f)).pending.map((task) => task._id)).toEqual([taskId]);
    if (!result) throw new Error("The closer has no Whop ask");
    return { fact, decisionId: result.decisionId };
  });

  const paymentId = await step("the closer confirms Whop and settles the task with a $25 shortfall", async () => {
    const id = await closer.mutation(api.closer.reminderOutcomes.logReminderPayment, {
      followUpId: taskId, programId, amount: 225, currency: "USD", paymentType: "pif",
      provider: {
        kind: "confirm", providerPaymentId: arrival.fact._id, decisionId: arrival.decisionId,
        expectedAllocationRevision: arrival.fact.allocationRevision,
      },
    });
    expect(await callState(f)).toMatchObject({
      deal: { stage: "closed", outcome: "won" }, meeting: { status: "held", attendanceDecisionId: ask.decisionId },
      tasks: [{ _id: taskId, status: "completed", completionOutcome: "payment_received", completionPaymentId: id }],
      pending: [],
    });
    const events = await t.run((ctx) => ctx.db.query("domainEvents")
      .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
        q.eq("tenantId", tenantId).eq("entityType", "followUp").eq("entityId", taskId)).take(10));
    const event = events.find((row) => row.eventType === "followUp.completed");
    expect(JSON.parse(event?.metadata ?? "{}")).toMatchObject({
      paymentId: id, expectedAmountMinor: 25_000, paidAmountMinor: 22_500,
      differenceMinor: -2_500, code: "amount_differs",
    });
    return id;
  });

  const correctionId = await step("Billing excludes a wrong match and leaves exactly one pending next step", async () => {
    const target = { paymentRecordId: paymentId, cause: "wrong_match" } as const;
    const preview = await admin.query(api.payments.exclude.previewExclusion, target);
    expect(preview.refusal).toBeUndefined();
    const result = await admin.mutation(api.payments.exclude.excludePayment, {
      ...target, level: "reviewed", disposition: "follow_up", followUpContactMethod: "text",
      expectedFingerprint: preview.fingerprint,
    });
    if (!result.ok) throw new Error(`Exclusion refused: ${result.code}`);
    const state = await callState(f);
    expect(state).toMatchObject({
      deal: { stage: "follow_up", outcome: "open" }, meeting: { status: "held", attendanceDecisionId: ask.decisionId },
      pending: [{ _id: taskId, contactMethod: "text", purpose: "payment_owed", reminderScheduledAt: promisedPaymentAt }],
    });
    expect(state.pending[0]?.completionPaymentId).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get("providerPayments", arrival.fact._id)))?.paymentRecordId).toBeUndefined();
    return result.correctionId;
  });

  await step("Billing restores the allocation and the same task completes again", async () => {
    const preview = await admin.query(api.payments.restore.previewRestore, { correctionId });
    expect(preview.result).toBe("restored_won");
    expect(await admin.mutation(api.payments.restore.restorePayment, {
      correctionId, expectedFingerprint: preview.fingerprint,
    })).toMatchObject({ ok: true, alreadyApplied: false });
    expect(await callState(f)).toMatchObject({
      deal: { stage: "closed", outcome: "won" }, meeting: { status: "held", attendanceDecisionId: ask.decisionId },
      tasks: [{ _id: taskId, status: "completed", completionPaymentId: paymentId }], pending: [],
    });
    expect(await t.run((ctx) => ctx.db.get("providerPayments", arrival.fact._id))).toMatchObject({ paymentRecordId: paymentId });
  });

  const callback = await step("a second deal gets a call-back ask", async () => {
    const call = await anotherCall(f, "Avery");
    await publish(call, { kind: "call_back" });
    const ask = await askFor(call);
    expect(ask).toMatchObject({ kind: "call_back", state: "ready" });
    return { call, ask };
  });

  const originalNextStep = await step("the closer confirms the call-back and the person counts as Showed", async () => {
    const id = await confirmTask(callback.call, callback.ask);
    await cancelSecondOpinionWorkers(f);
    expect(await callState(callback.call)).toMatchObject({
      person: { lifecycleStage: "showed" }, meeting: { status: "held" }, pending: [{ _id: id }],
    });
    expect(await admin.query(confirmCall.getCallResultSummary, { meetingId: callback.call.meetingId }))
      .toMatchObject({ can: { withdrawAttendance: true } });
    return id;
  });

  const replacementId = await step("Change the next step replaces the task and keeps the held mark", async () => {
    const reminderScheduledAt = Date.now() + HOUR;
    const result = await closer.mutation(taskCorrections.changeNextStep, {
      decisionId: callback.ask.decisionId, contactMethod: "text", reminderScheduledAt,
    });
    if (!result.ok) throw new Error(`Change refused: ${result.code}`);
    const state = await callState(callback.call);
    expect(state.meeting).toMatchObject({ status: "held", attendanceDecisionId: callback.ask.decisionId });
    expect(state.tasks).toContainEqual(expect.objectContaining({ _id: originalNextStep, status: "expired" }));
    expect(state.pending).toMatchObject([{ _id: result.followUpId, contactMethod: "text", reminderScheduledAt }]);
    return result.followUpId;
  });

  await step("the admin withdraws attendance and keeps the edited next step", async () => {
    expect(await admin.query(confirmCall.getCallResultSummary, { meetingId: callback.call.meetingId }))
      .toMatchObject({
        task: { followUpId: replacementId, contactMethod: "text" },
        can: { changeNextStep: false, withdrawAttendance: true, undo: false },
      });
    const result = await admin.mutation(taskCorrections.callDidNotHappen, { decisionId: callback.ask.decisionId });
    expect(result).toMatchObject({ ok: true });
    expect(await callState(callback.call)).toMatchObject({
      deal: { stage: "follow_up" }, person: { lifecycleStage: "booked" },
      meeting: { status: "scheduled" }, pending: [{ _id: replacementId }],
    });
    expect(await admin.query(confirmCall.getCallResultSummary, { meetingId: callback.call.meetingId })).toBeNull();
    expect(await t.run((ctx) => ctx.db.get("resultAutomationDecisions", callback.ask.decisionId)))
      .toMatchObject({ state: "undone" });
  });

  await step("sets up an earlier held call for the shared-person attendance case", async () => {
    const earlier = await anotherCall(f, "Avery", callback.call.leadId);
    await publish(earlier, { kind: "call_back" });
    await confirmTask(earlier, await askFor(earlier));
    await cancelSecondOpinionWorkers(f);
    expect((await callState(earlier)).meeting).toMatchObject({ status: "held" });
  });

  for (const hasOtherHeldCall of [false, true]) {
    const { call, decisionId, followUpId } = await step(hasOtherHeldCall
      ? "the closer confirms another call-back for a person already Showed"
      : "the closer confirms a call-back on a person's only meeting", async () => {
      const call = hasOtherHeldCall
        ? await anotherCall(f, "Avery", callback.call.leadId)
        : await anotherCall(f, "Milo");
      await publish(call, { kind: "call_back" });
      const ask = await askFor(call);
      const followUpId = await confirmTask(call, ask);
      await cancelSecondOpinionWorkers(f);
      expect(await callState(call)).toMatchObject({ person: { lifecycleStage: "showed" }, meeting: { status: "held" } });
      return { call, decisionId: ask.decisionId, followUpId };
    });
    await step(hasOtherHeldCall ? "withdrawing one held call keeps Showed while an earlier held call remains" :
      "withdrawing the only held call moves the person back from Showed", async () => {
      expect(await admin.mutation(taskCorrections.callDidNotHappen, { decisionId })).toEqual({ ok: true, alreadyApplied: false });
      const state = await callState(call);
      expect(state).toMatchObject({
        meeting: { status: "scheduled" }, deal: { stage: "booked", outcome: "open" },
        person: { lifecycleStage: hasOtherHeldCall ? "showed" : "booked" },
        tasks: [{ _id: followUpId, status: "expired" }], pending: [],
      });
      expect(state.meeting?.heldMarkedAt).toBeUndefined();
      expect(state.meeting?.attendanceDecisionId).toBeUndefined();
    });
  }

  const veto = await step("another prospect's reading raises a final call-back proposal", async () => {
    const call = await anotherCall(f, "Sana");
    await publish(call, { kind: "call_back" });
    const { decisionId } = await askFor(call);
    return { call, decisionId };
  });
  await step("the closer rejects the proposal with Not right", async () => {
    const { call, decisionId } = veto;
    expect(await closer.mutation(confirmCall.declineCallDecision, { decisionId })).toEqual({ ok: true, alreadyApplied: false });
    expect(await closer.query(confirmCall.getCallAsk, { meetingId: call.meetingId })).toBeNull();
    expect(await t.run((ctx) => ctx.db.get("resultAutomationDecisions", decisionId)))
      .toMatchObject({ state: "stopped", stopCode: "person_stop", resolvedByUserId: f.closerId });
  });

  await step("publishing a fresh reading cannot bring back the vetoed proposal", async () => {
    const { call } = veto;
    await publish(call, { kind: "call_back", generation: 2, trigger: "read_again" });
    expect(await closer.query(confirmCall.getCallAsk, { meetingId: call.meetingId })).toBeNull();
    const rows = await t.run((ctx) => ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_meetingId", (q) => q.eq("tenantId", tenantId).eq("meetingId", call.meetingId)).take(5));
    expect(rows).toHaveLength(2);
    expect(rows[1]?.gates).toContain("stood_down");
    expect(await callState(call)).toMatchObject({ meeting: { status: "scheduled" }, tasks: [] });
  });
});
