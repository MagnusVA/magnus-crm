import { anyApi, type ApiFromModules } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertAutomationInvariants } from "../../tests/automationInvariants";
import { callInsightsHarness, seedCallDecisionReading } from "../../tests/callInsightsHarness";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import { api, internal } from "../_generated/api";
import { insertMeetingAggregate, insertOpportunityAggregate } from "../reporting/writeHooks";
import { evaluateCallSubject } from "./callDecisions";
import { noteHumanResult } from "./humanResult";

const { automation: { confirmCall } } = anyApi as unknown as ApiFromModules<{
  "automation/confirmCall": typeof import("./confirmCall");
}>;
const NOW = Date.parse("2026-11-17T19:00:00Z");
const HOUR = 3_600_000;
const QUOTE = "Private statement from Grace, kept only on the reading.";

type Fixture = Awaited<ReturnType<typeof callInsightsHarness>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function checkInvariants(f: Fixture) {
  const scope = { tenantId: f.tenantId };
  await assertAutomationInvariants(f.t, scope);
  await assertPaymentInvariants(f.t, scope);
}

async function publish(f: Fixture, options?: Parameters<typeof seedCallDecisionReading>[1]) {
  const args = await seedCallDecisionReading(f, options);
  await f.t.mutation(internal.callInsights.run.publish, args);
  await f.t.run((ctx) => evaluateCallSubject(ctx, {
    tenantId: f.tenantId, meetingId: f.meetingId, cause: "published", now: Date.now(),
  }));
  return args.runId;
}

async function fixture(kind: "call_back" | "payment_owed" = "call_back") {
  const f = await callInsightsHarness({ settings: { mode: "on", suggestions: "on" } });
  await f.t.run(async (ctx) => {
    await insertOpportunityAggregate(ctx, f.opportunityId);
    await insertMeetingAggregate(ctx, f.meetingId);
  });
  await f.owner.mutation(api.automation.settings.setEnabled, { enabled: true });
  await f.owner.mutation(api.automation.settings.setKindMode, { kind, mode: "ask" });
  const runId = await publish(f, { kind });
  const meeting = { meetingId: f.meetingId };
  const ask = await f.closer.query(confirmCall.getCallAsk, meeting);
  if (!ask) throw new Error("Expected a call ask");
  return {
    ...f, runId, meeting, ask,
    args: { decisionId: ask.decisionId, expectedInputKey: ask.expectedInputKey },
  };
}

describe("confirming a task from a call", () => {
  it.each([
    ["call_back", "closer"],
    ["call_back", "admin"],
    ["payment_owed", "closer"],
    ["payment_owed", "admin"],
    ["payment_owed", "owner"],
  ] as const)("%s through the %s core", async (kind, role) => {
    const f = await fixture(kind);
    const actorId = role === "closer" ? f.closerId : role === "admin" ? f.adminId : f.ownerId;
    const promised = kind === "payment_owed"
      ? { expectedAmountMinor: 25000, expectedCurrency: "USD", promisedPaymentAt: NOW + 48 * HOUR }
      : {};
    expect(f.ask).toMatchObject({
      kind, state: "ready", gates: [], can: { confirm: true, decline: true },
      proposal: { type: "task", purpose: kind, contactMethod: "call", reminderScheduledAt: NOW + 48 * HOUR, ...promised },
      quotes: [{ quote: QUOTE, speaker: "Prospect", lineIndex: 2, atSeconds: 9 }],
    });
    const result = await f[role].mutation(confirmCall.confirmCallDecision, f.args);
    if (!result.ok) throw new Error(`Confirmation refused: ${result.code}`);
    expect(result.alreadyApplied).toBe(false);
    await checkInvariants(f);

    const stored = await f.t.run(async (ctx) => ({
      decision: await ctx.db.get("resultAutomationDecisions", f.args.decisionId),
      deal: await ctx.db.get("opportunities", f.opportunityId),
      meeting: await ctx.db.get("meetings", f.meetingId),
      followUp: await ctx.db.get("followUps", result.followUpId),
      checks: await ctx.db.query("secondOpinions").take(2),
      events: await ctx.db.query("domainEvents").take(20),
    }));
    expect(stored.deal).toMatchObject({ stage: "follow_up", outcome: "open", humanResultRevision: 1 });
    expect(stored.meeting).toMatchObject({
      status: "held", attendanceSource: "call_insights", attendanceDecisionId: f.args.decisionId,
    });
    expect(stored.decision).toMatchObject({
      state: "applied", appliedVia: "meeting_confirm", resolvedByUserId: actorId,
      writtenFollowUpId: result.followUpId, humanResultRevisionAfter: 1,
      callBefore: { position: "booked", meetingStatus: "scheduled" },
    });
    expect(stored.followUp).toMatchObject({
      opportunityId: f.opportunityId, closerId: f.closerId, sourceMeetingId: f.meetingId,
      purpose: kind, reason: "call_insights", createdByUserId: actorId,
      createdSource: role === "closer" ? "closer" : "admin", ...promised,
    });
    expect(stored.followUp?.reminderNote).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain(QUOTE);
    if (role === "closer") {
      expect(stored.checks).toMatchObject([{
        meetingId: f.meetingId, recordingId: f.recordingId, status: "queued",
        trigger: "result_recorded", record: { kind: "call_back" },
      }]);
    } else {
      expect(stored.checks).toEqual([]);
    }

    await expect(f.closer.query(confirmCall.getCallAsk, f.meeting)).resolves.toBeNull();
    await expect(f.closer.query(confirmCall.getCallResultSummary, f.meeting)).resolves.toMatchObject({
      entry: "confirmed", resolvedByUserId: actorId, meetingHeld: true,
      task: { followUpId: result.followUpId, purpose: kind, status: "pending", ...promised },
      can: { changeNextStep: true, withdrawAttendance: false, undo: false, reopen: false },
    });
    await expect(f.admin.query(confirmCall.getCallResultSummary, f.meeting)).resolves.toMatchObject({
      can: { changeNextStep: true, withdrawAttendance: true, undo: false, reopen: false },
    });
    await expect(f.other.query(confirmCall.getCallResultSummary, f.meeting)).resolves.toBeNull();
    await expect(f[role].mutation(confirmCall.confirmCallDecision, f.args)).resolves.toEqual({
      ...result, alreadyApplied: true,
    });
    await checkInvariants(f);
  });

  it("refuses the wrong key and a closer outside the deal", async () => {
    const f = await fixture();
    await expect(f.other.query(confirmCall.getCallAsk, f.meeting)).resolves.toBeNull();
    await expect(f.other.mutation(confirmCall.confirmCallDecision, f.args))
      .resolves.toEqual({ ok: false, code: "not_yours" });
    await expect(f.closer.mutation(confirmCall.confirmCallDecision, { ...f.args, expectedInputKey: "wrong" }))
      .resolves.toEqual({ ok: false, code: "stale_preview" });
    await expect(f.closer.query(confirmCall.getCallAsk, f.meeting)).resolves.toMatchObject({ state: "ready" });
    await checkInvariants(f);
  });

  it.each(["new run", "human result", "recording moved", "time passed"] as const)("refuses when %s invalidates the preview", async (cause) => {
    const f = await fixture();
    if (cause === "new run") await publish(f, { generation: 2 });
    if (cause === "human result") {
      await f.t.run((ctx) => noteHumanResult(ctx, f.opportunityId, { tenantId: f.tenantId, userId: f.closerId }));
    }
    if (cause === "recording moved") {
      await f.t.run((ctx) => ctx.db.patch("callRecordings", f.recordingId, { matchStatus: "unmatched", meetingId: undefined }));
    }
    if (cause === "time passed") vi.setSystemTime(NOW + 49 * HOUR);
    await expect(f.closer.mutation(confirmCall.confirmCallDecision, f.args))
      .resolves.toEqual({ ok: false, code: "stale_preview" });
    await f.t.run(async (ctx) => {
      expect(await ctx.db.query("followUps").first()).toBeNull();
      expect(await ctx.db.query("secondOpinions").first()).toBeNull();
      expect(await ctx.db.get("meetings", f.meetingId)).toMatchObject({ status: "scheduled" });
      expect(await ctx.db.get("resultAutomationDecisions", f.args.decisionId)).toMatchObject({
        state: cause === "human result" ? "stopped" : "superseded",
      });
    });
    await checkInvariants(f);
  });

  it("keeps the current settings gate and refuses a lowered kind", async () => {
    const f = await fixture();
    await f.owner.mutation(api.automation.settings.setKindMode, { kind: "call_back", mode: "shadow" });
    await expect(f.closer.mutation(confirmCall.confirmCallDecision, f.args)).resolves.toEqual({ ok: false, code: "kind_off" });
    await expect(f.closer.query(confirmCall.getCallAsk, f.meeting)).resolves.toBeNull();
    await checkInvariants(f);
  });

  it("keeps a human-planned task when it appears after the ask", async () => {
    const f = await fixture();
    const oldId = await f.t.run((ctx) => ctx.db.insert("followUps", {
      tenantId: f.tenantId, opportunityId: f.opportunityId, leadId: f.leadId, closerId: f.closerId,
      type: "manual_reminder", status: "pending", reason: "closer_initiated", createdAt: NOW,
      contactMethod: "text", reminderScheduledAt: NOW + HOUR, createdByUserId: f.closerId, createdSource: "closer",
    }));
    await expect(f.closer.mutation(confirmCall.confirmCallDecision, f.args))
      .resolves.toEqual({ ok: false, code: "stale_preview" });
    await expect(f.t.run((ctx) => ctx.db.query("followUps").take(2))).resolves.toMatchObject([{ _id: oldId, status: "pending" }]);
    await checkInvariants(f);
  });

  it("shows needs-person gates when the proposed time has passed", async () => {
    const f = await fixture();
    vi.setSystemTime(NOW + 49 * HOUR);
    await f.t.run((ctx) => evaluateCallSubject(ctx, {
      tenantId: f.tenantId, meetingId: f.meetingId, cause: "sweep", now: Date.now(),
    }));
    await expect(f.closer.query(confirmCall.getCallAsk, f.meeting)).resolves.toMatchObject({
      state: "needs_person", proposal: null, gates: ["time_past"], can: { confirm: false },
    });
    await checkInvariants(f);
  });

  it("honors Not right on a ready ask across a reread", async () => {
    const f = await fixture();
    const args = { decisionId: f.args.decisionId };
    await expect(f.closer.mutation(confirmCall.declineCallDecision, args)).resolves.toEqual({ ok: true, alreadyApplied: false });
    await expect(f.closer.mutation(confirmCall.declineCallDecision, args)).resolves.toEqual({ ok: true, alreadyApplied: true });
    await expect(f.closer.query(confirmCall.getCallAsk, f.meeting)).resolves.toBeNull();
    await checkInvariants(f);

    await publish(f, { generation: 2, trigger: "read_again" });
    await expect(f.closer.query(confirmCall.getCallAsk, f.meeting)).resolves.toBeNull();
    await f.t.run(async (ctx) => {
      expect(await ctx.db.get("resultAutomationDecisions", args.decisionId)).toMatchObject({
        state: "stopped", stopCode: "person_stop", resolvedByUserId: f.closerId,
      });
      const latest = await ctx.db.query("resultAutomationDecisions").order("desc").first();
      expect(latest?.gates).toContain("stood_down");
      expect(await ctx.db.query("followUps").first()).toBeNull();
    });
    await checkInvariants(f);
  });

  it.each(["ask", "applied"] as const)("removes expired and purged quotes from the %s view", async (state) => {
    const f = await fixture();
    const query = state === "applied" ? confirmCall.getCallResultSummary : confirmCall.getCallAsk;
    if (state === "applied") {
      await expect(f.admin.mutation(confirmCall.confirmCallDecision, f.args)).resolves.toMatchObject({ ok: true });
      await checkInvariants(f);
    }
    await expect(f.closer.query(query, f.meeting)).resolves.toMatchObject({ quotes: [{ quote: QUOTE }] });
    await f.t.run((ctx) => ctx.db.patch("callRecordings", f.recordingId, { transcriptExpiresAt: NOW }));
    await expect(f.closer.query(query, f.meeting)).resolves.toMatchObject({ quotes: [], quotesDeleted: true });
    await f.t.mutation(internal.callInsights.maintenance.purgeRecording, { recordingId: f.recordingId });
    await f.t.mutation(internal.callInsights.maintenance.purgeRecording, { recordingId: f.recordingId, runsDone: true });
    const after = await f.closer.query(query, f.meeting);
    if (state === "ask") expect(after).toBeNull();
    else expect(after).toMatchObject({ decisionId: f.args.decisionId, entry: "confirmed", quotes: [], quotesDeleted: true });
    const run = await f.t.run((ctx) => ctx.db.get("callInsightRuns", f.runId));
    expect(run).toMatchObject({ quotesPurgedAt: NOW, evidence: { statements: [{ quote: "" }] } });
    await checkInvariants(f);
  });
});
