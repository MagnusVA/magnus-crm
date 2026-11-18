import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertAutomationInvariants } from "../../tests/automationInvariants";
import { callTaskFixture, readCallForTask as readCall } from "../../tests/callInsightsHarness";
import { insertTask } from "../../tests/closerPipelineFixtures";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { computeLatestActivityAt, patchOpportunityLifecycle } from "../lib/opportunityActivity";

const NOW = Date.parse("2026-11-17T19:00:00Z");
const execute = internal.automation.apply.executeCallTask;
type Fixture = Awaited<ReturnType<typeof callTaskFixture>>;
type DecisionId = Id<"resultAutomationDecisions">;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function invariants(f: Fixture) {
  await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  await assertAutomationInvariants(f.t, { tenantId: f.tenantId });
}

async function written(f: Fixture, decisionId: DecisionId) {
  return await f.t.run(async (ctx) => {
    const decision = (await ctx.db.get("resultAutomationDecisions", decisionId))!;
    const task = decision.writtenFollowUpId ? await ctx.db.get("followUps", decision.writtenFollowUpId) : null;
    const meeting = (await ctx.db.get("meetings", f.meetingId))!;
    const deal = (await ctx.db.get("opportunities", f.opportunityId))!;
    const events = await ctx.db.query("domainEvents").take(50);
    return {
      decision, task, meeting, deal,
      secondOpinions: (await ctx.db.query("secondOpinions").take(5)).length,
      lines: await ctx.db.query("closerPinnedLines").take(5),
      // The write's own events: the owner's settings changes are setup.
      events: events.filter(({ eventType }) => eventType !== "automation.settings_changed")
        .map(({ eventType, source, actorUserId, metadata }) => ({
          eventType, source, actorUserId, decisionId: JSON.parse(metadata ?? "{}").decisionId,
        })),
    };
  });
}

describe("executeCallTask", () => {
  it.each(["call_back", "payment_owed"] as const)(
    "sets the %s an ask confirm sets, minus the actor and Second opinion, keeping last activity",
    async (kind) => {
      const ask = await callTaskFixture(kind, false);
      const askId = await readCall(ask, kind);
      const askDecision = (await ask.t.run((ctx) => ctx.db.get("resultAutomationDecisions", askId)))!;
      expect(askDecision).toMatchObject({ state: "ready", mode: "ask" });
      expect(await ask.closer.mutation(api.automation.confirmCall.confirmCallDecision, {
        decisionId: askId, expectedInputKey: askDecision.inputKey,
      })).toMatchObject({ ok: true, alreadyApplied: false });
      const confirmed = await written(ask, askId);
      await invariants(ask);

      const f = await callTaskFixture(kind, true);
      const before = await f.t.run(async (ctx) => {
        await patchOpportunityLifecycle(ctx, f.opportunityId, { latestActivityAt: NOW - 3 * 3_600_000 });
        return await ctx.db.get("opportunities", f.opportunityId);
      });
      const decisionId = await readCall(f, kind);
      expect(await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", decisionId))).toMatchObject({
        state: "ready", mode: "automatic", dueAt: NOW, wouldWrite: true,
      });
      await invariants(f);
      // The insert scheduled the executor at once.
      await vi.advanceTimersByTimeAsync(0);
      await f.t.finishInProgressScheduledFunctions();
      const auto = await written(f, decisionId);
      await invariants(f);

      const taskFields = (task: NonNullable<typeof auto.task>) => ({
        type: task.type, contactMethod: task.contactMethod, reminderScheduledAt: task.reminderScheduledAt,
        reason: task.reason, status: task.status, purpose: task.purpose, expectedAmountMinor: task.expectedAmountMinor,
        expectedCurrency: task.expectedCurrency, promisedPaymentAt: task.promisedPaymentAt, declineCode: task.declineCode,
        reminderNote: task.reminderNote, closerId: task.closerId, sourceMeetingId: task.sourceMeetingId,
      });
      expect(taskFields(auto.task!)).toEqual({ ...taskFields(confirmed.task!), closerId: f.closerId, sourceMeetingId: f.meetingId });
      expect(auto.task).toMatchObject({ createdSource: "system", automationDecisionId: decisionId, reason: "call_insights", purpose: kind });
      expect(auto.task?.createdByUserId).toBeUndefined();
      expect(confirmed.task).toMatchObject({ createdSource: "closer", createdByUserId: ask.closerId });

      const meetingFields = ({ status, attendanceSource, heldMarkedAt }: typeof auto.meeting) => ({ status, attendanceSource, heldMarkedAt });
      expect(meetingFields(auto.meeting)).toEqual(meetingFields(confirmed.meeting));
      expect(auto.meeting.attendanceDecisionId).toBe(decisionId);
      expect(auto.deal).toMatchObject({ stage: "follow_up", outcome: "open" });
      // The reading's write keeps the deal's last activity: the call's own time, not the write's.
      const lastActivity = before!.latestActivityAt ?? computeLatestActivityAt(before!);
      expect(auto.deal.latestActivityAt).toBe(lastActivity);
      expect(lastActivity).toBeLessThan(NOW);
      expect(auto.deal.humanResultRevision ?? 0).toBe(0);
      expect(confirmed.deal).toMatchObject({ stage: "follow_up", humanResultRevision: 1 });

      // The same events, the system's with no actor; Second opinion only for the closer's confirm.
      // The system path lands the deal after the held mark, so only the order differs.
      const types = (events: typeof auto.events) => events.map(({ eventType }) => eventType).sort();
      expect(types(auto.events)).toEqual(types(confirmed.events));
      expect(auto.events.every(({ source, actorUserId }) => source === "system" && actorUserId === undefined)).toBe(true);
      expect(auto.events.some(({ decisionId: id }) => id === decisionId)).toBe(true);
      expect(confirmed.secondOpinions).toBe(1);
      expect(auto.secondOpinions).toBe(0);

      expect(auto.decision).toMatchObject({
        state: "applied", mode: "automatic", appliedVia: "automatic", certificateSampleId: f.sampleId,
        humanResultRevisionAfter: 0, auditReason: "canary",
        callBefore: { position: "booked", meetingId: f.meetingId, meetingStatus: "scheduled", followUpId: auto.task?._id },
      });
      expect(auto.decision.resolvedByUserId).toBeUndefined();
      expect(confirmed.decision).toMatchObject({ mode: "ask", appliedVia: "meeting_confirm", resolvedByUserId: ask.closerId });
      expect(auto.lines).toMatchObject([{
        kind: "call_result_set", userId: f.closerId, meetingId: f.meetingId, followUpId: auto.task?._id, decisionId,
      }]);
      const tenant = await f.t.run((ctx) => ctx.db.get("tenants", f.tenantId));
      expect(tenant?.resultAutomation?.kinds[kind]?.automatic?.writes).toBe(1);
    },
  );

  it("writes once however often it wakes", async () => {
    const f = await callTaskFixture("call_back", true);
    const decisionId = await readCall(f, "call_back");
    const first = await f.t.mutation(execute, { decisionId });
    expect(first).toMatchObject({ ok: true, alreadyApplied: false });
    expect(await f.t.mutation(execute, { decisionId })).toEqual({ ...first, alreadyApplied: true });
    const tasks = await f.t.run((ctx) => ctx.db.query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) => q.eq("opportunityId", f.opportunityId)).take(5));
    expect(tasks).toHaveLength(1);
    await invariants(f);
  });

  it("is retried by the sweep when its wake-up was missed", async () => {
    const f = await callTaskFixture("payment_owed", true);
    const decisionId = await readCall(f, "payment_owed");
    await f.t.mutation(internal.automation.sweep.dueAutomaticPage, { cursor: null, through: NOW });
    await vi.advanceTimersByTimeAsync(0);
    await f.t.finishInProgressScheduledFunctions();
    expect(await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", decisionId)))
      .toMatchObject({ state: "applied", mode: "automatic", appliedVia: "automatic" });
    await invariants(f);
  });

  it("supersedes and writes nothing when the facts changed since the reading", async () => {
    const f = await callTaskFixture("call_back", true);
    const decisionId = await readCall(f, "call_back");
    await f.t.run((ctx) => insertTask(ctx, {
      opportunityId: f.opportunityId, type: "manual_reminder", reason: "closer_initiated", status: "pending",
    }));
    expect(await f.t.mutation(execute, { decisionId })).toEqual({ ok: false, code: "stale_preview" });
    expect(await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", decisionId)))
      .toMatchObject({ state: "superseded", stopCode: "input_changed" });
    expect(await f.t.run((ctx) => ctx.db.get("meetings", f.meetingId))).toMatchObject({ status: "scheduled" });
    await invariants(f);
  });

  const refusals: Array<[string, (f: Fixture) => Promise<unknown>, "kind_off" | "certificate_lapsed"]> = [
    ["the kind is at ask", (f) => f.t.run(async (ctx) => {
      const settings = (await ctx.db.get("tenants", f.tenantId))!.resultAutomation!;
      const { automatic: _automatic, ...policy } = settings.kinds.call_back!;
      await ctx.db.patch("tenants", f.tenantId, {
        resultAutomation: { ...settings, kinds: { ...settings.kinds, call_back: { ...policy, mode: "ask" } } },
      });
    }), "kind_off"],
    ["the certificate lapsed", (f) => f.t.run((ctx) => ctx.db.patch("automationSamples", f.sampleId!, {
      status: "lapsed", lapsedAt: NOW, lapseReason: "rule_changed",
    })), "certificate_lapsed"],
    ["the breaker tripped", (f) => f.t.run(async (ctx) => {
      const settings = (await ctx.db.get("tenants", f.tenantId))!.resultAutomation!;
      await ctx.db.patch("tenants", f.tenantId, {
        resultAutomation: { ...settings, kinds: { ...settings.kinds, call_back: {
          ...settings.kinds.call_back!, breaker: { trippedAt: NOW, reason: "audit_overdue" },
        } } },
      });
    }), "kind_off"],
    ["automation is paused", (f) => f.t.run(async (ctx) => {
      const settings = (await ctx.db.get("tenants", f.tenantId))!.resultAutomation!;
      await ctx.db.patch("tenants", f.tenantId, { resultAutomation: { ...settings, enabled: false, pausedAt: NOW } });
    }), "kind_off"],
  ];
  it.each(refusals)("writes nothing when %s", async (name, change, code) => {
    const f = await callTaskFixture("call_back", true);
    const decisionId = await readCall(f, "call_back");
    await change(f);
    expect(await f.t.mutation(execute, { decisionId })).toEqual({ ok: false, code });
    const { decision, task, meeting, lines } = await written(f, decisionId);
    if (name === "automation is paused") expect(decision).toMatchObject({ state: "stopped", stopCode: "paused" });
    else expect(decision).toMatchObject({ state: "ready", mode: "ask" });
    expect(task).toBeNull();
    expect(meeting).toMatchObject({ status: "scheduled" });
    expect(lines).toEqual([]);
    expect(await f.t.mutation(execute, { decisionId })).toEqual({ ok: false, code: "not_ready" });
    await invariants(f);
  });
});
