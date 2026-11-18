import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertAutomationInvariants } from "../../tests/automationInvariants";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import { callInsightsHarness, seedCallDecisionReading } from "../../tests/callInsightsHarness";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { onRecordingUnmatchedForInsights } from "../callInsights/trigger";
import { evaluateCallSubject, rederiveCall, schedulePublishedCallEvaluation, type CallEvaluateCause } from "./callDecisions";
import { stopDecision } from "./decisions";
import { noteHumanResult } from "./humanResult";
import type { CallKind } from "./proposals";
import { currentRuleVersion } from "./settings";

const NOW = Date.parse("2026-11-17T19:00:00Z");
const HOUR = 3_600_000;
const kinds = ["call_back", "payment_owed", "refusal_loss"] as const;
type Fixture = Awaited<ReturnType<typeof callInsightsHarness>>;
type Mode = "off" | "shadow" | "ask";
type Decision = Doc<"resultAutomationDecisions">;

const evaluateCallMeeting = makeFunctionReference<"mutation", { meetingId: Id<"meetings">; cause: CallEvaluateCause }>(
  "automation/callDecisions:evaluateCallMeeting",
);

const listCallProposals = makeFunctionReference<"query", {
  kind?: CallKind; paginationOpts: { cursor: string | null; numItems: number };
}, { page: Decision[] }>("automation/callDecisions:listCallProposals");

const callRepair = makeFunctionReference<"mutation", {
  tenantId: Id<"tenants">; state: "ready"; cursor: null; through: number;
}>("automation/sweep:callRepair");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function fixture(kind: CallKind = "call_back", mode: Mode = "ask") {
  const f = await callInsightsHarness();
  await f.owner.mutation(api.automation.settings.setEnabled, { enabled: true });
  await f.owner.mutation(api.automation.settings.setKindMode, { kind, mode });
  return f;
}

async function publish(f: Fixture, options?: Parameters<typeof seedCallDecisionReading>[1]) {
  const args = await seedCallDecisionReading(f, options);
  await f.t.mutation(internal.callInsights.run.publish, args);
  return args.runId;
}

async function decisions(f: Fixture) {
  return await f.t.run((ctx) => ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_meetingId", (q) => q.eq("tenantId", f.tenantId).eq("meetingId", f.meetingId))
    .take(25));
}

const evaluate = (f: Fixture, cause: CallEvaluateCause = "published") =>
  f.t.mutation(evaluateCallMeeting, { meetingId: f.meetingId, cause });

async function verifyInvariants(f: Fixture) {
  const scope = { tenantId: f.tenantId };
  await assertAutomationInvariants(f.t, scope);
  await assertPaymentInvariants(f.t, scope);
}

describe("published call decisions", () => {
  it.each(kinds)("stores one current %s decision for repeated publish evaluation", async (kind) => {
    const f = await fixture(kind);
    const runId = await publish(f, { kind });
    const first = await evaluate(f);
    expect(await evaluate(f)).toEqual(first);
    const rows = await decisions(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId, kind, state: "ready", mode: "ask", wouldWrite: true, noticeUserId: f.closerId,
      evidence: { type: "call", finalStatementLine: 2 },
    });
    expect(await f.t.run((ctx) => rederiveCall(ctx, rows[0], NOW + 1))).toMatchObject({ same: true });
    if (kind !== "refusal_loss") {
      expect(await f.t.run((ctx) => rederiveCall(ctx, rows[0], NOW + 48 * HOUR))).toMatchObject({
        same: false, derived: { gates: ["time_past"] },
      });
    }
    await verifyInvariants(f);
  });

  it("schedules the slot's end and makes a clean decision askable when it ends", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.patch("meetings", f.meetingId, { scheduledAt: NOW - 5 * 60_000, durationMinutes: 10 }));
    await publish(f);
    await vi.advanceTimersByTimeAsync(0);
    await f.t.finishInProgressScheduledFunctions();
    expect(await decisions(f)).toMatchObject([{ state: "needs_person", gates: ["slot_not_over"] }]);
    await verifyInvariants(f);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await f.t.finishInProgressScheduledFunctions();
    expect(await decisions(f)).toMatchObject([{ state: "superseded" }, { state: "ready", gates: [] }]);
    await verifyInvariants(f);
  });

  it("supersedes on a same-run reprojection and when a new run changes the result family", async () => {
    const f = await fixture();
    await f.owner.mutation(api.automation.settings.setKindMode, { kind: "refusal_loss", mode: "ask" });
    const originalRunId = await publish(f);
    const original = await evaluate(f);
    await f.t.mutation(internal.callInsights.publish.reproject, { recordingId: f.recordingId });
    const reprojected = await evaluate(f, "reprojected");
    expect(reprojected).not.toEqual(original);
    expect(await decisions(f)).toMatchObject([
      { state: "superseded", stopCode: "input_changed", supersededByDecisionId: reprojected.decisionIds[0], runId: originalRunId },
      { state: "ready", runId: originalRunId },
    ]);
    await verifyInvariants(f);

    const runId = await publish(f, { generation: 2, kind: "refusal_loss" });
    await evaluate(f);
    expect(await decisions(f)).toMatchObject([
      { state: "superseded" }, { state: "superseded" }, { state: "ready", kind: "refusal_loss", runId },
    ]);
    await verifyInvariants(f);
  });

  it.each(["move", "purge"] as const)("stops outstanding decisions after %s and retains prior applied receipts", async (how) => {
    const f = await fixture();
    await publish(f);
    const { decisionIds: [receiptId] } = await evaluate(f);
    await f.t.run((ctx) => ctx.db.patch("resultAutomationDecisions", receiptId, { state: "applied", appliedVia: "meeting_confirm", resolvedAt: NOW }));
    await publish(f, { generation: 2 });
    await evaluate(f);
    await verifyInvariants(f);

    if (how === "move") {
      const newMeetingId = await f.t.run(async (ctx) => {
        const { _id, _creationTime, ...meeting } = (await ctx.db.get("meetings", f.meetingId))!;
        void _id;
        void _creationTime;
        const meetingId = await ctx.db.insert("meetings", { ...meeting, scheduledAt: meeting.scheduledAt - HOUR });
        await ctx.db.patch("callRecordings", f.recordingId, { meetingId });
        await onRecordingUnmatchedForInsights(ctx, { recordingId: f.recordingId });
        return meetingId;
      });
      expect(newMeetingId).not.toBe(f.meetingId);
    } else {
      await f.t.mutation(internal.callInsights.maintenance.purgeRecording, { recordingId: f.recordingId });
      await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    }
    expect(await decisions(f)).toMatchObject([
      { _id: receiptId, state: "applied", appliedVia: "meeting_confirm" },
      { state: "stopped", stopCode: how === "move" ? "recording_moved" : "transcript_gone" },
    ]);
    expect(await evaluate(f)).toEqual({ decisionIds: [] });
    await verifyInvariants(f);
  });

  it("lets the one-task gate abstain without modifying the existing planned task", async () => {
    const f = await fixture("payment_owed");
    const taskId = await f.t.run((ctx) => ctx.db.insert("followUps", {
      tenantId: f.tenantId, opportunityId: f.opportunityId, leadId: f.leadId, closerId: f.closerId,
      status: "pending", type: "manual_reminder", reason: "closer_initiated", contactMethod: "text",
      reminderScheduledAt: NOW + HOUR, createdAt: NOW - 1,
    }));
    const getTask = () => f.t.run((ctx) => ctx.db.get("followUps", taskId));
    const before = await getTask();
    await publish(f, { kind: "payment_owed" });
    await evaluate(f);
    expect(await decisions(f)).toMatchObject([{ kind: "payment_owed", state: "needs_person", gates: ["open_task"] }]);
    expect(await getTask()).toEqual(before);
    await verifyInvariants(f);
  });

  it("returns before loading evidence with every call kind and the alert off", async () => {
    const f = await fixture("call_back", "off");
    await publish(f);
    expect(await decisions(f)).toEqual([]);
    await f.t.run(async (ctx) => {
      const [tenant, meeting] = await Promise.all([ctx.db.get("tenants", f.tenantId), ctx.db.get("meetings", f.meetingId)]);
      const get = vi.spyOn(ctx.db, "get");
      const query = vi.spyOn(ctx.db, "query");
      const schedule = vi.spyOn(ctx.scheduler, "runAfter");
      await schedulePublishedCallEvaluation(ctx, tenant, meeting!, "published", NOW);
      expect(schedule).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(await evaluateCallSubject(ctx, { ...f, now: NOW, cause: "published" })).toEqual({ decisionIds: [] });
      expect(get.mock.calls).toEqual([["tenants", f.tenantId]]);
      expect(query).not.toHaveBeenCalled();
    });
    await verifyInvariants(f);
  });

  it.each(["shadow", "ask"] as const)("stores %s with a durable veto across a reread, reprojection and policy bump", async (mode) => {
    const f = await fixture("refusal_loss", mode);
    await publish(f, { kind: "refusal_loss" });
    const { decisionIds: [first] } = await evaluate(f);
    await f.t.run((ctx) => stopDecision(ctx, first, { userId: f.ownerId }, "person_stop"));
    await verifyInvariants(f);

    await publish(f, { kind: "refusal_loss", generation: 2, trigger: "read_again" });
    await evaluate(f);
    await f.t.mutation(internal.callInsights.publish.reproject, { recordingId: f.recordingId });
    await evaluate(f, "reprojected");
    await f.owner.mutation(api.automation.settings.setKindMode, { kind: "refusal_loss", mode: mode === "shadow" ? "ask" : "shadow" });
    await evaluate(f, "settings");
    const rows = await decisions(f);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map(({ vetoKey }) => vetoKey)).size).toBe(1);
    expect(rows[0]).toMatchObject({ state: "stopped", stopCode: "person_stop" });
    for (const row of rows.slice(1)) {
      expect(row.gates).toContain("stood_down");
      expect(row.proposal).toBeUndefined();
    }
    await verifyInvariants(f);

    await f.t.run((ctx) => ctx.db.patch("resultAutomationDecisions", first, { vetoReleasedAt: NOW + 1, vetoReleasedByUserId: f.ownerId }));
    await evaluate(f, "settings");
    expect((await decisions(f)).at(-1)).toMatchObject({ gates: ["not_fresh_read"], wouldWrite: false, proposal: { type: "refusal" } });
    await verifyInvariants(f);
  });

  it("replaces an acknowledged notice with an unacknowledged new round on reassignment", async () => {
    const f = await fixture("refusal_loss");
    await f.t.run(async (ctx) => {
      const tenant = (await ctx.db.get("tenants", f.tenantId))!;
      const settings = tenant.resultAutomation!;
      const ruleVersion = currentRuleVersion(tenant, "refusal_loss");
      const sampleId = await ctx.db.insert("automationSamples", {
        tenantId: f.tenantId, kind: "refusal_loss", ruleVersion, target: 0, status: "certified", certifiedAt: NOW, createdAt: NOW,
      });
      await ctx.db.patch("tenants", f.tenantId, {
        resultAutomation: {
          ...settings, kinds: {
            ...settings.kinds, refusal_loss: {
              ...settings.kinds.refusal_loss!, mode: "automatic",
              automatic: { promotedAt: NOW, promotedByUserId: f.ownerId, sampleId, ruleVersion, writes: 0 },
            },
          },
        },
      });
    });
    await publish(f, { kind: "refusal_loss" });
    const { decisionIds: [first] } = await evaluate(f);
    await f.t.run((ctx) => ctx.db.patch("resultAutomationDecisions", first, {
      acknowledgedAt: NOW, acknowledgedByUserId: f.closerId, acknowledgedAs: "closer", noticeHours: 48, dueAt: NOW + 48 * HOUR,
    }));
    await verifyInvariants(f);

    await f.t.run(async (ctx) => {
      await ctx.db.patch("opportunities", f.opportunityId, { assignedCloserId: f.otherId });
      await ctx.db.patch("meetings", f.meetingId, { assignedCloserId: f.otherId });
      await noteHumanResult(ctx, f.opportunityId, { tenantId: f.tenantId, userId: f.adminId }, { cause: "assignment" });
    });
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await decisions(f);
    expect(rows).toMatchObject([
      { state: "stopped", stopCode: "closer_changed", noticeRound: 1, noticeUserId: f.closerId },
      { state: "notice", noticeRound: 2, noticeUserId: f.otherId, humanResultRevision: 1 },
    ]);
    expect(rows[1]).not.toHaveProperty("acknowledgedAt");
    expect(rows[1]).not.toHaveProperty("dueAt");
    await verifyInvariants(f);

    await f.t.run((ctx) => noteHumanResult(ctx, f.opportunityId, { tenantId: f.tenantId, userId: f.otherId }));
    expect((await decisions(f)).at(-1)).toMatchObject({ state: "stopped", stopCode: "human_result" });
    await verifyInvariants(f);
  });

  it("repairs a missed publication stop and transcript expiration", async () => {
    const f = await fixture();
    await publish(f);
    await evaluate(f);
    await publish(f, { generation: 2 });
    await f.t.mutation(callRepair, { tenantId: f.tenantId, state: "ready", cursor: null, through: NOW + 1 });
    expect((await decisions(f))[0]).toMatchObject({ state: "superseded", stopCode: "input_changed" });
    await evaluate(f);
    await verifyInvariants(f);
    await f.t.run((ctx) => ctx.db.patch("callRecordings", f.recordingId, { transcriptExpiresAt: NOW }));
    await f.t.mutation(callRepair, { tenantId: f.tenantId, state: "ready", cursor: null, through: NOW + 1 });
    expect((await decisions(f)).at(-1)).toMatchObject({ state: "stopped", stopCode: "transcript_gone" });
    await verifyInvariants(f);
  });
});

describe("call automation controls", () => {
  it.each(kinds)("lets only owners raise %s and stops it when Call insights is off", async (kind) => {
    const f = await fixture(kind, "off");
    await expect(f.admin.mutation(api.automation.settings.setKindMode, { kind, mode: "shadow" })).rejects.toThrow("Insufficient permissions");
    await f.owner.mutation(api.automation.settings.setKindMode, { kind, mode: "shadow" });
    await publish(f, { kind });
    await evaluate(f);
    expect((await decisions(f))[0]).toMatchObject({ state: "shadow", mode: "shadow" });
    expect((await f.admin.query(listCallProposals, { kind, paginationOpts: { cursor: null, numItems: 10 } })).page).toEqual([]);
    await expect(f.closer.query(listCallProposals, { kind, paginationOpts: { cursor: null, numItems: 10 } })).rejects.toThrow("Insufficient permissions");
    await verifyInvariants(f);

    await expect(f.admin.mutation(api.automation.settings.setKindMode, { kind, mode: "ask" })).rejects.toThrow("Insufficient permissions");
    await f.owner.mutation(api.automation.settings.setKindMode, { kind, mode: "ask" });
    await evaluate(f, "settings");
    expect((await decisions(f)).at(-1)).toMatchObject({ state: "ready", mode: "ask" });
    await expect(f.owner.mutation(api.automation.settings.setKindMode, {
      // @ts-expect-error The public validator must also refuse automatic at runtime.
      kind, mode: "automatic",
    })).rejects.toThrow(/Validator error|ArgumentValidation/);
    await f.admin.mutation(api.automation.settings.setKindMode, { kind, mode: "shadow" });
    expect((await decisions(f)).at(-1)).toMatchObject({ state: "stopped", stopCode: "kind_lowered" });
    await evaluate(f, "settings");
    await f.admin.mutation(api.callInsights.admin.updateSettings, { mode: "off" });
    expect((await decisions(f)).at(-1)).toMatchObject({ state: "stopped", stopCode: "kind_lowered" });
    expect(await evaluate(f, "settings")).toEqual({ decisionIds: [] });
    expect((await f.owner.query(api.automation.settings.getSettings, {})).callEffective?.[kind]).toBe("off");
    await verifyInvariants(f);
  });

  it("sets alert grace and notice hours under owner authority, then fires the alert at grace", async () => {
    const f = await fixture("call_back", "off");
    const settings = api.automation.settings;
    await expect(f.admin.mutation(settings.setAlertMode, { mode: "on" })).rejects.toThrow("Insufficient permissions");
    await expect(f.admin.mutation(settings.setRefusalNoticeHours, { hours: 60 })).rejects.toThrow("Insufficient permissions");
    await expect(f.owner.mutation(settings.setAlertMode, { mode: "on", graceMinutes: 29 })).rejects.toThrow("30 to 1440");
    await expect(f.owner.mutation(settings.setRefusalNoticeHours, { hours: 169 })).rejects.toThrow("24 to 168");
    await f.owner.mutation(settings.setRefusalNoticeHours, { hours: 60 });
    await f.owner.mutation(settings.setAlertMode, { mode: "on", graceMinutes: 120 });
    await publish(f, { alert: true });
    expect(await evaluate(f)).toEqual({ decisionIds: [] });
    await verifyInvariants(f);

    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await decisions(f)).toMatchObject([{ kind: "paid_on_call_alert", state: "ready", wouldWrite: true, noticeUserId: f.closerId }]);
    expect((await f.owner.query(settings.getSettings, {})).configured).toMatchObject({ refusalNoticeHours: 60, paidOnCallAlert: { mode: "on", graceMinutes: 120 } });
    await f.admin.mutation(settings.setAlertMode, { mode: "shadow" });
    expect((await decisions(f)).at(-1)).toMatchObject({ state: "stopped", stopCode: "kind_lowered" });
    await evaluate(f, "settings");
    expect((await decisions(f)).at(-1)).toMatchObject({ state: "shadow", mode: "shadow" });
    await verifyInvariants(f);
  });
});
