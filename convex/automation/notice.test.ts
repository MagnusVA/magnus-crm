import { anyApi, makeFunctionReference, type ApiFromModules } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertAutomationInvariants } from "../../tests/automationInvariants";
import { callInsightsHarness, seedCallDecisionReading } from "../../tests/callInsightsHarness";
import { insertProgram } from "../../tests/enrollmentFixtures";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import {
  callEvidenceRef, FIXTURE_NOW, insertPaymentFixtureConnection, insertProviderDeal, insertProviderFact,
  insertProviderMeeting, insertProviderPerson, seedAutomationSample, seedManualPayment, seedReadyDecision,
} from "../../tests/providerPaymentFixtures";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { headerFor } from "../callInsights/trigger";
import { insertManualReminder } from "../lib/reminderInsert";
import { patchMeetingLifecycle } from "../lib/meetingLifecycle";
import { missedMeetingLoss, patchOpportunityLifecycle, transitionOpportunity } from "../lib/opportunityActivity";
import { sha256Hex } from "../lib/stableHash";
import { insertMeetingAggregate, insertOpportunityAggregate } from "../reporting/writeHooks";
import { evaluateCallSubject, rederiveCall, type CallEvaluateCause } from "./callDecisions";
import { CERTIFICATE_TARGET } from "./certificates";
import { noteHumanResult } from "./humanResult";
import {
  captureRefusalNoticeBefore, DEFAULT_REFUSAL_NOTICE_HOURS, LATE_WAKEUP_MS, scheduleRefusalDeadlinePass, STALE_RETRY_MS,
  WHOP_FRESH_FOR_REFUSAL_MS,
} from "./notice";
import { stopCallDecisionsOnPayment } from "./paymentHooks";
import { currentRuleVersion } from "./settings";

const { automation: { notice, certificates } } = anyApi as unknown as ApiFromModules<{
  "automation/notice": typeof import("./notice");
  "automation/certificates": typeof import("./certificates");
}>;
type Decision = Doc<"resultAutomationDecisions">;
type DecisionArgs = { decisionId: Id<"resultAutomationDecisions"> };
type Harness = Awaited<ReturnType<typeof callInsightsHarness>>;
type TenantSettings = NonNullable<Doc<"tenants">["resultAutomation"]>;

const KIND = "refusal_loss";
const HOUR_MS = 3_600_000;
const DUE = FIXTURE_NOW + DEFAULT_REFUSAL_NOTICE_HOURS * HOUR_MS;
const finalizeRefusal = makeFunctionReference<"mutation", DecisionArgs>("automation/notice:finalizeRefusal");
const deadlinePage = makeFunctionReference<"mutation", { through: number; cursor: string | null }>(
  "automation/notice:refusalDeadlinePage",
);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function seedCertifiedSample(f: Harness, runId: Id<"callInsightRuns">) {
  const target = CERTIFICATE_TARGET[KIND];
  const sample = await f.t.run(async (ctx) => {
    const tenant = (await ctx.db.get("tenants", f.tenantId))!;
    const ruleVersion = currentRuleVersion(tenant, KIND);
    const policyVersion = tenant.resultAutomation!.kinds[KIND]!.policyVersion;
    const sampleId = await seedAutomationSample(ctx, {
      tenantId: f.tenantId, kind: KIND, ruleVersion, target, status: "certified",
      firstCaseAt: FIXTURE_NOW, certifiedAt: FIXTURE_NOW,
    });
    return { sampleId, ruleVersion, policyVersion };
  });
  for (let offset = 0; offset < target; offset += 100) {
    await f.t.run(async (ctx) => {
      for (let i = offset; i < Math.min(offset + 100, target); i++) {
        const leadId = await insertProviderPerson(ctx, f.tenantId);
        const key = await sha256Hex(`refusal case ${leadId}`);
        const rowId = await seedReadyDecision(ctx, {
          tenantId: f.tenantId, leadId, kind: KIND, inputKey: key, vetoKey: key,
          ...sample,
          evidence: callEvidenceRef({ runId, recordingId: f.recordingId }),
          grade: {
            verdict: "correct", wrongFields: [], gradedByUserId: f.adminId,
            gradedAt: FIXTURE_NOW, gradedBeforeSeeing: true,
          },
        });
        await ctx.db.patch("resultAutomationDecisions", rowId, { mode: "shadow", state: "shadow" });
      }
    });
  }
  await expect(f.owner.mutation(certificates.promoteKind, { kind: KIND, sampleId: sample.sampleId }))
    .resolves.toMatchObject({ ok: true, sampleId: sample.sampleId });
  return sample.sampleId;
}

const evaluate = (f: Harness, cause: CallEvaluateCause = "published") => f.t.run((ctx) => evaluateCallSubject(ctx, {
  tenantId: f.tenantId, meetingId: f.meetingId, cause, now: Date.now(),
}));

async function fixture(position: "booked" | "follow_up" = "booked") {
  const f = await callInsightsHarness({ settings: { mode: "on", suggestions: "on" } });
  await f.t.run(async (ctx) => {
    await insertOpportunityAggregate(ctx, f.opportunityId);
    await insertMeetingAggregate(ctx, f.meetingId);
    if (position === "follow_up") {
      await transitionOpportunity(ctx, f.opportunityId, {
        to: { stage: position }, source: "admin", actorUserId: f.adminId, occurredAt: Date.now(),
      });
    }
  });
  await f.owner.mutation(api.automation.settings.setEnabled, { enabled: true });
  await f.owner.mutation(api.automation.settings.setKindMode, { kind: KIND, mode: "ask" });
  const reading = await seedCallDecisionReading(f, { kind: KIND });
  const sampleId = await seedCertifiedSample(f, reading.runId);
  await f.t.mutation(internal.callInsights.run.publish, reading);
  const { decisionIds: [decisionId] } = await evaluate(f);
  await f.t.run(async (ctx) => {
    const row = await ctx.db.get("resultAutomationDecisions", decisionId);
    expect(row).toMatchObject({ state: "notice", mode: "automatic", noticeRound: 1 });
    // The call evaluator's notice-creation hook captures this in production.
    if (!row?.callBefore) {
      const meeting = (await ctx.db.get("meetings", f.meetingId))!;
      await ctx.db.patch("resultAutomationDecisions", decisionId, {
        callBefore: await captureRefusalNoticeBefore(ctx, f.opportunityId, meeting),
      });
    }
  });
  return { ...f, reading, sampleId, args: { decisionId } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function invariants(f: Fixture) {
  await assertAutomationInvariants(f.t, { tenantId: f.tenantId });
  await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
}

function state(f: Fixture, decisionId = f.args.decisionId) {
  return f.t.run(async (ctx) => ({
    row: await ctx.db.get("resultAutomationDecisions", decisionId),
    deal: await ctx.db.get("opportunities", f.opportunityId),
    meeting: await ctx.db.get("meetings", f.meetingId),
    pinned: await ctx.db.query("closerPinnedLines").take(10),
  }));
}

const finalize = (f: Fixture, args = f.args) => f.t.mutation(finalizeRefusal, args);

async function acknowledge(f: Fixture, actor: "closer" | "admin" | "owner" = "closer") {
  await expect(f[actor].mutation(notice.acknowledgeNotice, f.args)).resolves.toEqual({ ok: true, alreadyApplied: false });
}

async function dueFixture() {
  const f = await fixture();
  await acknowledge(f);
  vi.setSystemTime(DUE);
  return f;
}

async function expectWithdrawal(f: Fixture, code: NonNullable<Decision["stopCode"]>) {
  await expect(finalize(f)).resolves.toEqual({ status: "withdrawn", code });
  const { row, deal, pinned } = await state(f);
  expect(row).toMatchObject({ state: code === "input_changed" ? "superseded" : "stopped", stopCode: code });
  expect(deal?.lostReason).not.toBe("call_refusal");
  expect(pinned).toContainEqual(expect.objectContaining({
    kind: "refusal_notice_withdrawn", decisionId: f.args.decisionId, userId: f.closerId,
  }));
  await invariants(f);
}

async function patchSettings(f: Fixture, change: (settings: TenantSettings) => TenantSettings) {
  await f.t.run(async (ctx) => {
    const tenant = (await ctx.db.get("tenants", f.tenantId))!;
    await ctx.db.patch("tenants", f.tenantId, { resultAutomation: change(tenant.resultAutomation!) });
  });
}

function patchPolicy(f: Fixture, change: Partial<TenantSettings["kinds"][typeof KIND]>) {
  return patchSettings(f, (settings) => ({
    ...settings, kinds: { ...settings.kinds, [KIND]: { ...settings.kinds[KIND]!, ...change } },
  }));
}

const noticesForMeeting = (f: Fixture) => f.t.run((ctx) => ctx.db.query("resultAutomationDecisions")
  .withIndex("by_tenantId_and_meetingId", (q) => q.eq("tenantId", f.tenantId).eq("meetingId", f.meetingId))
  .take(20));

it("1: no acknowledgment never starts a deadline, and a minute early is a noop", async () => {
  const f = await fixture();
  vi.setSystemTime(DUE + LATE_WAKEUP_MS + 7 * 24 * HOUR_MS);
  await expect(finalize(f)).resolves.toEqual({ status: "noop" });
  const now = Date.now();
  expect((await state(f)).row?.dueAt).toBeUndefined();
  await invariants(f);

  await acknowledge(f);
  vi.setSystemTime(now + DEFAULT_REFUSAL_NOTICE_HOURS * HOUR_MS - 60_000);
  await expect(finalize(f)).resolves.toEqual({ status: "noop" });
  expect(await state(f)).toMatchObject({ deal: { outcome: "open" }, meeting: { status: "scheduled" } });
  await invariants(f);
});

it.each(["booked", "follow_up"] as const)("writes exactly once at the deadline from %s", async (position) => {
  const f = await fixture(position);
  await acknowledge(f);
  vi.setSystemTime(DUE);
  const receipt = { status: "applied", ...f.args };
  await expect(finalize(f)).resolves.toEqual({ ...receipt, alreadyApplied: false });
  await expect(finalize(f)).resolves.toEqual({ ...receipt, alreadyApplied: true });
  const { row, deal, meeting, pinned } = await state(f);
  expect(row).toMatchObject({
    state: "applied", appliedVia: "automatic", mode: "automatic", resolvedAt: DUE,
    certificateSampleId: f.sampleId, callBefore: { position }, auditReason: "canary",
  });
  expect(row?.auditOpenDueAt).toBeGreaterThan(DUE);
  expect(row?.resolvedByUserId).toBeUndefined();
  expect(deal).toMatchObject({ stage: "closed", outcome: "lost", lostReason: "call_refusal", lostAt: DUE });
  expect(deal?.lostByUserId).toBeUndefined();
  expect(meeting).toMatchObject({ status: "held", heldMarkedAt: DUE,
    attendanceSource: "call_insights", attendanceDecisionId: f.args.decisionId });
  expect(pinned).toMatchObject([{ kind: "refusal_recorded", userId: f.closerId, ...f.args }]);
  expect(await f.t.run((ctx) => ctx.db.query("secondOpinions").take(2))).toEqual([]);
  await invariants(f);
});

it("2: a wake-up more than a day late starts a new unacknowledged round", async () => {
  const f = await dueFixture();
  vi.setSystemTime(DUE + LATE_WAKEUP_MS + 1);
  const result = await finalize(f);
  expect(result).toMatchObject({ status: "restarted", decisionId: expect.any(String) });
  const [retired, fresh] = await noticesForMeeting(f);
  expect(retired).toMatchObject({ state: "stopped", stopCode: "late_wakeup", supersededByDecisionId: fresh._id });
  expect(fresh).toMatchObject({ state: "notice", noticeRound: 2, noticeUserId: f.closerId });
  expect(fresh.acknowledgedAt).toBeUndefined();
  expect(fresh.dueAt).toBeUndefined();
  await expect(finalize(f, { decisionId: fresh._id })).resolves.toEqual({ status: "noop" });
  expect((await evaluate(f, "sweep")).decisionIds).toContain(fresh._id);
  await invariants(f);
});

it.each(["suspended", "paused"] as const)("3: a %s tenant withdraws at the deadline", async (cause) => {
  const f = await dueFixture();
  if (cause === "suspended") {
    await f.t.run((ctx) => ctx.db.patch("tenants", f.tenantId, { status: "suspended" }));
  } else {
    await patchSettings(f, (settings) => ({ ...settings, enabled: false, pausedAt: DUE }));
  }
  await expectWithdrawal(f, "paused");
});

it.each(["certificate_lapsed", "breaker", "lowered"] as const)("4: %s withdraws to an ask", async (cause) => {
  const f = await dueFixture();
  if (cause === "certificate_lapsed") {
    await f.t.run((ctx) => ctx.db.patch("automationSamples", f.sampleId, { status: "lapsed" }));
  } else if (cause === "breaker") {
    await patchPolicy(f, { breaker: { reason: "wrong_write", trippedAt: DUE } });
  } else {
    await patchPolicy(f, { mode: "ask" });
  }
  await expectWithdrawal(f, cause === "certificate_lapsed" ? cause : "kind_lowered");
  expect(await noticesForMeeting(f)).toMatchObject([{ state: "stopped" }, { state: "ready", mode: "ask" }]);
});

it.each(["activationVersion", "policyVersion"] as const)("5: a changed %s withdraws the pending write", async (version) => {
  const f = await dueFixture();
  await patchSettings(f, (settings) => version === "activationVersion"
    ? { ...settings, activationVersion: settings.activationVersion + 1 }
    : { ...settings, kinds: {
        ...settings.kinds, [KIND]: { ...settings.kinds[KIND]!, policyVersion: settings.kinds[KIND]!.policyVersion + 1 },
      } });
  await expectWithdrawal(f, "kind_lowered");
});

it("5: changing another kind leaves the refusal alone, while lowering refusal withdraws it", async () => {
  const f = await dueFixture();
  await f.owner.mutation(api.automation.settings.setKindMode, { kind: "call_back", mode: "ask" });
  expect((await state(f)).row).toMatchObject({ state: "notice", dueAt: DUE });
  await invariants(f);
  await f.owner.mutation(certificates.demoteKind, { kind: KIND });
  expect((await state(f)).row).toMatchObject({ state: "stopped", stopCode: "kind_lowered" });
  await expect(finalize(f)).resolves.toEqual({ status: "noop" });
  await invariants(f);
});

it.each(["published run", "recording match", "person"] as const)("6: a different %s withdraws the notice", async (change) => {
  const f = await dueFixture();
  await f.t.run(async (ctx) => {
    if (change === "published run") {
      const header = (await headerFor(ctx, f.recordingId))!;
      await ctx.db.patch("callInsightFacts", header._id, { publishedRunId: undefined });
    } else if (change === "recording match") {
      await ctx.db.patch("callRecordings", f.recordingId, { meetingId: undefined });
    } else {
      const leadId = await insertProviderPerson(ctx, f.tenantId);
      await patchOpportunityLifecycle(ctx, f.opportunityId, { leadId });
    }
  });
  await expectWithdrawal(f, "recording_moved");
});

it("7: an expired transcript withdraws the notice", async () => {
  const f = await dueFixture();
  await f.t.run((ctx) => ctx.db.patch("callRecordings", f.recordingId, { transcriptExpiresAt: DUE }));
  await expectWithdrawal(f, "transcript_gone");
});

it.each(["stage", "meeting status", "meeting time"] as const)("8: a changed %s withdraws the notice", async (change) => {
  const f = await dueFixture();
  await f.t.run(async (ctx) => {
    if (change === "stage") {
      await transitionOpportunity(ctx, f.opportunityId, {
        to: { stage: "follow_up" }, source: "admin", actorUserId: f.adminId, occurredAt: DUE,
      });
    } else if (change === "meeting status") {
      await patchMeetingLifecycle(ctx, f.meetingId, { status: "canceled", canceledAt: DUE });
      await transitionOpportunity(ctx, f.opportunityId, {
        to: { stage: "closed", outcome: "lost" }, source: "system", occurredAt: DUE,
        fields: missedMeetingLoss("canceled", DUE), reason: "canceled",
      });
    } else {
      const meeting = (await ctx.db.get("meetings", f.meetingId))!;
      await ctx.db.patch("meetings", f.meetingId, { scheduledAt: meeting.scheduledAt + 60_000 });
    }
  });
  await expectWithdrawal(f, "deal_closed");
});

it.each(["revision", "task"] as const)("9: a new human %s withdraws at the deadline", async (change) => {
  const f = await dueFixture();
  await f.t.run(async (ctx) => {
    const deal = (await ctx.db.get("opportunities", f.opportunityId))!;
    if (change === "revision") {
      await ctx.db.patch("opportunities", f.opportunityId, { humanResultRevision: 1 });
    } else {
      await insertManualReminder(ctx, {
        opportunity: deal, closerId: f.closerId, source: "closer", actorUserId: f.closerId,
        contactMethod: "call", reminderScheduledAt: DUE + HOUR_MS, reason: "closer_initiated", now: DUE,
      });
    }
  });
  await expectWithdrawal(f, "human_result");
});

it("9: a real human save stops the timer before finalize can run", async () => {
  const f = await dueFixture();
  await f.t.run((ctx) => noteHumanResult(ctx, f.opportunityId, { tenantId: f.tenantId, userId: f.closerId }));
  expect((await state(f)).row).toMatchObject({ state: "stopped", stopCode: "human_result" });
  await expect(finalize(f)).resolves.toEqual({ status: "noop" });
  await invariants(f);
});

it("10: an unreleased veto for the same call withdraws a later notice", async () => {
  const f = await dueFixture();
  await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...row } = (await ctx.db.get("resultAutomationDecisions", f.args.decisionId))!;
    await ctx.db.insert("resultAutomationDecisions", {
      ...row, state: "stopped", stopCode: "person_stop", resolvedByUserId: f.closerId,
      resolvedAt: DUE - 1, inputKey: await sha256Hex(_id),
    });
  });
  await expectWithdrawal(f, "person_stop");
});

it("11: an assignment that reaches the deadline creates an unacknowledged notice for the new closer", async () => {
  const f = await dueFixture();
  await f.t.run((ctx) => patchOpportunityLifecycle(ctx, f.opportunityId, { assignedCloserId: f.otherId }));
  await expect(finalize(f)).resolves.toMatchObject({ status: "restarted" });
  const [retired, fresh] = await noticesForMeeting(f);
  expect(retired).toMatchObject({ state: "stopped", stopCode: "closer_changed", supersededByDecisionId: fresh._id });
  expect(fresh).toMatchObject({ state: "notice", noticeRound: 2, noticeUserId: f.otherId });
  expect(fresh.acknowledgedAt).toBeUndefined();
  expect(fresh.dueAt).toBeUndefined();
  await expect(f.closer.mutation(notice.acknowledgeNotice, { decisionId: fresh._id }))
    .resolves.toEqual({ ok: false, code: "not_yours" });
  await expect(finalize(f, { decisionId: fresh._id })).resolves.toEqual({ status: "noop" });
  await invariants(f);
});

it("11: a real reassignment stands down the old timer and re-evaluates for the new closer", async () => {
  const f = await dueFixture();
  await f.t.run(async (ctx) => {
    await patchOpportunityLifecycle(ctx, f.opportunityId, { assignedCloserId: f.otherId });
    await noteHumanResult(ctx, f.opportunityId, { tenantId: f.tenantId, userId: f.adminId }, { cause: "assignment" });
  });
  await evaluate(f, "assignment");
  expect(await noticesForMeeting(f)).toMatchObject([
    { state: "stopped", stopCode: "closer_changed" },
    { state: "notice", noticeRound: 2, noticeUserId: f.otherId, humanResultRevision: 1 },
  ]);
  await expect(finalize(f)).resolves.toEqual({ status: "noop" });
  await invariants(f);
});

async function newerMeeting(f: Fixture, ctx: MutationCtx, status: Doc<"meetings">["status"] = "scheduled") {
  const opportunityId = await insertProviderDeal(ctx, {
    tenantId: f.tenantId, leadId: f.leadId, assignedCloserId: f.closerId,
    ...(status === "canceled" ? { position: "lost", lostReason: "canceled" } : {}),
  });
  return insertProviderMeeting(ctx, {
    tenantId: f.tenantId, opportunityId, closerId: f.closerId, scheduledAt: DUE + HOUR_MS, status,
  });
}

it("12: a newer booking on another deal for the person withdraws the notice", async () => {
  const f = await dueFixture();
  await f.t.run((ctx) => newerMeeting(f, ctx));
  await expectWithdrawal(f, "newer_meeting");
});

it("12: a canceled newer booking allows the refusal", async () => {
  const f = await dueFixture();
  await f.t.run((ctx) => newerMeeting(f, ctx, "canceled"));
  await expect(finalize(f)).resolves.toMatchObject({ status: "applied" });
  await invariants(f);
});

it("13: a real manual meeting payment stops the notice", async () => {
  const f = await dueFixture();
  const programId = await f.t.run((ctx) => insertProgram(ctx, f.tenantId, "Program"));
  await f.admin.mutation(api.closer.payments.logPayment, {
    meetingId: f.meetingId, opportunityId: f.opportunityId, amount: 100, currency: "USD",
    programId, paymentType: "pif",
  });
  await expect(finalize(f)).resolves.toEqual({ status: "noop" });
  expect(await state(f)).toMatchObject({ row: { state: "stopped" }, deal: { outcome: "won" } });
  await invariants(f);
});

it("13: a counting manual payment on a sibling deal withdraws the notice even without a hook", async () => {
  const f = await dueFixture();
  await f.t.run(async (ctx) => {
    const opportunityId = await insertProviderDeal(ctx, {
      tenantId: f.tenantId, leadId: f.leadId, assignedCloserId: f.closerId,
    });
    const programId = await insertProgram(ctx, f.tenantId, "Program");
    const paymentId = await seedManualPayment(ctx, { ...f, personId: f.leadId }, {
      opportunityId, programId, recordedAt: DUE,
    });
    await transitionOpportunity(ctx, opportunityId, {
      to: { stage: "closed", outcome: "won" }, source: "closer", actorUserId: f.closerId,
      occurredAt: DUE, metadata: { paymentId }, fields: { paymentReceivedAt: DUE, updatedAt: DUE },
    });
  });
  await expectWithdrawal(f, "payment_found");
});

it.each(["resolved", "unresolved"] as const)("13: a %s Whop payment for the person blocks the write", async (match) => {
  const f = await dueFixture();
  await f.t.run(async (ctx) => {
    const connectionId = await insertPaymentFixtureConnection(ctx, f.tenantId, f.ownerId);
    await insertProviderFact(ctx, f.tenantId, connectionId, match === "resolved"
      ? { leadId: f.leadId, status: "paid" }
      : { candidateLeadId: f.leadId, status: "unresolved", paidAt: undefined });
  });
  await expectWithdrawal(f, "payment_found");
});

it("13: Whop payment resolution stops the notice while the clock is running", async () => {
  const f = await fixture();
  await acknowledge(f);
  vi.setSystemTime(FIXTURE_NOW + HOUR_MS);
  await f.t.run(async (ctx) => {
    const connectionId = await insertPaymentFixtureConnection(ctx, f.tenantId, f.ownerId);
    await insertProviderFact(ctx, f.tenantId, connectionId, { leadId: f.leadId });
    await stopCallDecisionsOnPayment(ctx, { tenantId: f.tenantId, leadId: f.leadId, paidAt: Date.now() });
  });
  expect((await state(f)).row).toMatchObject({ state: "stopped", stopCode: "payment_found" });
  vi.setSystemTime(DUE);
  await expect(finalize(f)).resolves.toEqual({ status: "noop" });
  await invariants(f);
});

it("14: stale Whop schedules reconciliation and a retry, then applies once fresh", async () => {
  const f = await dueFixture();
  const connectionId = await f.t.run(async (ctx) => {
    const id = await insertPaymentFixtureConnection(ctx, f.tenantId, f.ownerId);
    await ctx.db.patch("tenantPaymentConnections", id, { lastSuccessfulSweepAt: DUE - WHOP_FRESH_FOR_REFUSAL_MS - 1 });
    return id;
  });
  await expect(finalize(f)).resolves.toEqual({ status: "retry", retryAt: DUE + STALE_RETRY_MS });
  expect(await state(f)).toMatchObject({ row: { state: "notice", dueAt: DUE }, deal: { outcome: "open" }, meeting: { status: "scheduled" } });
  const jobs = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(30));
  expect(jobs).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "payments/reconcile:sweepRecent", args: [{ connectionId, through: DUE }] }),
    expect.objectContaining({ name: "automation/notice:finalizeRefusal", scheduledTime: DUE + STALE_RETRY_MS }),
  ]));
  await invariants(f);

  vi.setSystemTime(DUE + STALE_RETRY_MS);
  await f.t.run((ctx) => ctx.db.patch("tenantPaymentConnections", connectionId, { lastSuccessfulSweepAt: Date.now() }));
  await expect(finalize(f)).resolves.toMatchObject({ status: "applied", alreadyApplied: false });
  await invariants(f);
});

it("15: a reprojection changing the fingerprint supersedes the pending notice", async () => {
  const f = await dueFixture();
  await f.t.run(async (ctx) => {
    const header = (await headerFor(ctx, f.recordingId))!;
    await ctx.db.patch("callInsightFacts", header._id, { publicationRevision: (header.publicationRevision ?? 0) + 1 });
  });
  await expectWithdrawal(f, "input_changed");
});

it("the queues carry names and times, and only acknowledgment schedules a deadline", async () => {
  const f = await fixture();
  const expected = {
    ...f.args, opportunityId: f.opportunityId, meetingId: f.meetingId, leadId: f.leadId,
    noticeUserId: f.closerId, personName: "Grace", createdAt: FIXTURE_NOW, ageMs: 0,
  };
  await expect(f.closer.query(notice.listMyNotices, {})).resolves.toEqual({ notices: [expected], capped: false });
  await expect(f.other.query(notice.listMyNotices, {})).resolves.toEqual({ notices: [], capped: false });
  await expect(f.admin.query(notice.listNotices, {})).resolves.toEqual({ notices: [{ ...expected, closerName: "Kim" }], capped: false });
  await expect(f.closer.query(notice.listNotices, {})).rejects.toThrow("Insufficient permissions");
  expect((await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(30)))
    .filter((job) => job.name === "automation/notice:finalizeRefusal")).toEqual([]);
  await f.owner.mutation(api.automation.settings.setRefusalNoticeHours, { hours: 72 });
  await acknowledge(f, "owner");
  vi.setSystemTime(FIXTURE_NOW + HOUR_MS);
  await expect(f.closer.mutation(notice.acknowledgeNotice, f.args)).resolves.toEqual({ ok: true, alreadyApplied: true });
  const dueAt = FIXTURE_NOW + 72 * HOUR_MS;
  await expect(f.closer.query(notice.listMyNotices, {})).resolves.toEqual({
    notices: [{ ...expected, ageMs: HOUR_MS, acknowledgedAt: FIXTURE_NOW, dueAt }], capped: false,
  });
  expect((await state(f)).row).toMatchObject({
    acknowledgedAs: "admin", acknowledgedByUserId: f.ownerId, noticeHours: 72, dueAt,
  });
  expect((await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(30)))
    .filter((job) => job.name === "automation/notice:finalizeRefusal")).toMatchObject([{ args: [f.args], scheduledTime: dueAt }]);
  await invariants(f);
});

it("both queues put an unacknowledged notice before an earlier acknowledged one", async () => {
  const f = await fixture();
  await acknowledge(f);
  vi.setSystemTime(FIXTURE_NOW + HOUR_MS);
  const id = await f.t.run(async (ctx) => {
    const original = (await ctx.db.get("resultAutomationDecisions", f.args.decisionId))!;
    const leadId = await insertProviderPerson(ctx, f.tenantId);
    const opportunityId = await insertProviderDeal(ctx, {
      tenantId: f.tenantId, leadId, assignedCloserId: f.closerId,
    });
    const meetingId = await insertProviderMeeting(ctx, {
      tenantId: f.tenantId, opportunityId, closerId: f.closerId, scheduledAt: FIXTURE_NOW - HOUR_MS,
    });
    return ctx.db.insert("resultAutomationDecisions", {
      tenantId: f.tenantId, leadId, opportunityId, meetingId,
      kind: KIND, state: "notice", mode: "automatic", noticeRound: 1, noticeUserId: f.closerId,
      inputKey: await sha256Hex(meetingId), vetoKey: await sha256Hex(opportunityId),
      ruleVersion: original.ruleVersion, policyVersion: original.policyVersion,
      activationVersion: original.activationVersion, wouldWrite: true, humanResultRevision: 0,
      gates: [], evidence: original.evidence, createdAt: Date.now(),
    });
  });
  const unacknowledgedFirst = [
    { decisionId: id, personName: "River Patel", ageMs: 0 },
    { ...f.args, dueAt: DUE, personName: "Grace", ageMs: HOUR_MS },
  ];
  await expect(f.closer.query(notice.listMyNotices, {})).resolves.toMatchObject({ notices: unacknowledgedFirst });
  await expect(f.owner.query(notice.listNotices, {})).resolves.toMatchObject({ notices: unacknowledgedFirst });
  await invariants(f);
});

it("the bounded deadline pass schedules only elapsed, acknowledged notices", async () => {
  const f = await fixture();
  await acknowledge(f);
  await f.t.run((ctx) => scheduleRefusalDeadlinePass(ctx, DUE - 1));
  await f.t.mutation(deadlinePage, { through: DUE - 1, cursor: null });
  await f.t.mutation(deadlinePage, { through: DUE, cursor: null });
  await f.t.mutation(deadlinePage, { through: DUE, cursor: null });
  const jobs = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(30));
  expect(jobs.filter((job) => job.name === "automation/notice:refusalDeadlinePage"))
    .toMatchObject([{ args: [{ through: DUE - 1, cursor: null }] }]);
  expect(jobs.filter((job) => job.name === "automation/notice:finalizeRefusal"))
    .toMatchObject([{ args: [f.args] }, { args: [{ ...f.args, fromSweep: true }] }, { args: [{ ...f.args, fromSweep: true }] }]);
  await invariants(f);
});

it.each(["keep_open", "call_back"] as const)("Stop wins at the deadline with %s and records one human task", async (kind) => {
  const f = await dueFixture();
  const caller = kind === "call_back" ? f.closer : f.admin;
  const nextStep = kind === "call_back"
    ? { kind, contactMethod: "text" as const, reminderScheduledAt: DUE + HOUR_MS }
    : { kind };
  const result = await caller.mutation(notice.stopNotice, { ...f.args, nextStep });
  expect(result).toMatchObject({ ok: true, alreadyApplied: false });
  if (!result.ok) throw new Error("Stop was refused");
  await expect(caller.mutation(notice.stopNotice, { ...f.args, nextStep })).resolves.toEqual({ ...result, alreadyApplied: true });
  await expect(finalize(f)).resolves.toEqual({ status: "noop" });
  const { row, deal, meeting } = await state(f);
  expect(row).toMatchObject({ state: "stopped", stopCode: "person_stop", stopNextStep: {
    kind: kind === "keep_open" ? "reminder_now" : kind, followUpId: result.followUpId,
  } });
  expect(deal).toMatchObject({ stage: "follow_up", outcome: "open", humanResultRevision: 1 });
  expect(meeting).toMatchObject({ status: "held" });
  expect(meeting?.attendanceDecisionId).toBeUndefined();
  const tasks = await f.t.run((ctx) => ctx.db.query("followUps").take(5));
  expect(tasks).toMatchObject([{
    _id: result.followUpId, closerId: f.closerId, automationDecisionId: f.args.decisionId,
    createdByUserId: kind === "call_back" ? f.closerId : f.adminId, sourceMeetingId: f.meetingId,
    reminderScheduledAt: kind === "keep_open" ? DUE : DUE + HOUR_MS,
    contactMethod: kind === "call_back" ? "text" : "call", purpose: "call_back", status: "pending",
  }]);
  await invariants(f);
});

it("Stop after finalize cannot create a task or rewrite the receipt", async () => {
  const f = await dueFixture();
  await expect(finalize(f)).resolves.toMatchObject({ status: "applied", alreadyApplied: false });
  await expect(f.closer.mutation(notice.stopNotice, { ...f.args, nextStep: { kind: "keep_open" } }))
    .resolves.toEqual({ ok: false, code: "not_ready" });
  await expect(finalize(f)).resolves.toMatchObject({ status: "applied", alreadyApplied: true });
  expect(await f.t.run((ctx) => ctx.db.query("followUps").take(2))).toEqual([]);
  await invariants(f);
});

it("a veto survives a re-read, reprojection and policy change until an admin releases it", async () => {
  const f = await fixture();
  await f.closer.mutation(notice.stopNotice, { ...f.args, nextStep: { kind: "keep_open" } });
  await invariants(f);
  const checkVeto = async () => {
    const rows = await noticesForMeeting(f);
    expect(rows.filter((row) => row.state === "notice" || row.state === "ready")).toEqual([]);
    expect(rows.at(-1)?.gates).toContain("stood_down");
    await invariants(f);
  };
  const reading = await seedCallDecisionReading(f, { kind: KIND, generation: 2 });
  await f.t.mutation(internal.callInsights.run.publish, reading);
  await evaluate(f, "published");
  await checkVeto();
  await f.t.mutation(internal.callInsights.publish.reproject, { recordingId: f.recordingId });
  await evaluate(f, "reprojected");
  await checkVeto();
  const { row } = await state(f);
  await patchPolicy(f, { policyVersion: row!.policyVersion + 1 });
  await evaluate(f, "settings");
  await checkVeto();

  await expect(f.closer.mutation(notice.releaseVeto, f.args)).rejects.toThrow("Insufficient permissions");
  await expect(f.admin.mutation(notice.releaseVeto, f.args)).resolves.toEqual({ ok: true, alreadyApplied: false });
  await expect(f.admin.mutation(notice.releaseVeto, f.args)).resolves.toEqual({ ok: true, alreadyApplied: true });
  await evaluate(f, "settings");
  const stopped = (await state(f)).row;
  expect(stopped).toMatchObject({ vetoReleasedAt: FIXTURE_NOW, vetoReleasedByUserId: f.adminId });
  expect(await f.t.run((ctx) => rederiveCall(ctx, stopped!, Date.now()))).toMatchObject({
    derived: { wouldWrite: false },
  });
  expect((await noticesForMeeting(f)).at(-1)?.gates).not.toContain("stood_down");
  await invariants(f);
});

it.each(["closer", "admin"] as const)("Close now records the %s as the person who confirmed", async (role) => {
  const f = await fixture();
  await expect(f[role].mutation(notice.closeNow, f.args)).resolves.toEqual({ ...f.args, ok: true, alreadyApplied: false });
  await expect(f[role].mutation(notice.closeNow, f.args)).resolves.toEqual({ ...f.args, ok: true, alreadyApplied: true });
  const userId = role === "closer" ? f.closerId : f.adminId;
  expect(await state(f)).toMatchObject({
    row: { mode: "ask", appliedVia: "meeting_confirm", resolvedByUserId: userId },
    deal: { outcome: "lost", lostReason: "call_refusal", lostByUserId: userId },
  });
  await invariants(f);
});

it("another closer cannot acknowledge, stop or close, and a past call-back is refused", async () => {
  const f = await fixture();
  await expect(f.other.mutation(notice.acknowledgeNotice, f.args)).resolves.toEqual({ ok: false, code: "not_yours" });
  await expect(f.other.mutation(notice.stopNotice, { ...f.args, nextStep: { kind: "keep_open" } }))
    .resolves.toEqual({ ok: false, code: "not_yours" });
  await expect(f.other.mutation(notice.closeNow, f.args)).resolves.toEqual({ ok: false, code: "not_yours" });
  await expect(f.closer.mutation(notice.stopNotice, {
    ...f.args, nextStep: { kind: "call_back", contactMethod: "call", reminderScheduledAt: FIXTURE_NOW },
  })).resolves.toEqual({ ok: false, code: "time_past" });
  expect((await state(f)).row?.acknowledgedAt).toBeUndefined();
  await invariants(f);
});
