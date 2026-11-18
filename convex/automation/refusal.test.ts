import { anyApi, type ApiFromModules } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertAutomationInvariants } from "../../tests/automationInvariants";
import { callInsightsHarness, seedCallDecisionReading } from "../../tests/callInsightsHarness";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import { api, internal } from "../_generated/api";
import { isPersonLoss } from "../reporting/lib/outcomeDerivation";
import { exportRowsFromSql } from "../reports/rowsExport";
import { insertMeetingAggregate, insertOpportunityAggregate } from "../reporting/writeHooks";
import { evaluateCallSubject } from "./callDecisions";
import { noteHumanResult } from "./humanResult";

const { automation: { confirmCall, refusal } } = anyApi as unknown as ApiFromModules<{
  "automation/confirmCall": typeof import("./confirmCall");
  "automation/refusal": typeof import("./refusal");
}>;
const NOW = Date.parse("2026-11-17T19:00:00Z");
const DAY = 86_400_000;
const RANGE = { startDate: NOW - DAY, endDate: NOW + 1 };
const LABEL = "Refused on the call";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function fixture() {
  const f = await callInsightsHarness({ settings: { mode: "on", suggestions: "on" } });
  await f.t.run(async (ctx) => {
    await insertOpportunityAggregate(ctx, f.opportunityId);
    await insertMeetingAggregate(ctx, f.meetingId);
  });
  const kind = "refusal_loss";
  await f.owner.mutation(api.automation.settings.setEnabled, { enabled: true });
  await f.owner.mutation(api.automation.settings.setKindMode, { kind, mode: "ask" });
  const reading = await seedCallDecisionReading(f, { kind });
  await f.t.mutation(internal.callInsights.run.publish, reading);
  await f.t.run((ctx) => evaluateCallSubject(ctx, {
    tenantId: f.tenantId, meetingId: f.meetingId, cause: "published", now: NOW,
  }));
  const meeting = { meetingId: f.meetingId };
  const ask = await f.closer.query(confirmCall.getCallAsk, meeting);
  if (!ask) throw new Error("Expected a refusal ask");
  return {
    ...f, meeting,
    args: { decisionId: ask.decisionId, expectedInputKey: ask.expectedInputKey },
  };
}

async function checkInvariants(f: Pick<Awaited<ReturnType<typeof fixture>>, "t" | "tenantId">) {
  const scope = { tenantId: f.tenantId };
  await assertAutomationInvariants(f.t, scope);
  await assertPaymentInvariants(f.t, scope);
}

describe("confirming and reopening a refusal", () => {
  it.each(["closer", "admin"] as const)("%s confirms and reopens, preserving attendance", async (role) => {
    const f = await fixture();
    const actor = f[role];
    const actorId = role === "closer" ? f.closerId : f.adminId;
    const confirmResult = { ok: true, alreadyApplied: false, decisionId: f.args.decisionId };
    await expect(actor.mutation(refusal.confirmRefusal, f.args)).resolves.toEqual(confirmResult);
    await expect(actor.mutation(refusal.confirmRefusal, f.args)).resolves.toEqual({ ...confirmResult, alreadyApplied: true });
    await checkInvariants(f);

    const before = await f.t.run(async (ctx) => ({
      deal: await ctx.db.get("opportunities", f.opportunityId),
      meeting: await ctx.db.get("meetings", f.meetingId),
      checks: await ctx.db.query("secondOpinions").take(2),
    }));
    expect(before.deal).toMatchObject({ stage: "closed", outcome: "lost", lostReason: "call_refusal", lostByUserId: actorId, lostAt: NOW });
    expect(before.meeting).toMatchObject({ status: "held", heldMarkedAt: NOW, attendanceDecisionId: f.args.decisionId });
    if (role === "closer") {
      expect(before.checks).toMatchObject([{
        meetingId: f.meetingId, recordingId: f.recordingId, status: "queued",
        trigger: "result_recorded", record: { kind: "lost" },
      }]);
    } else {
      expect(before.checks).toEqual([]);
    }

    await expect(f.closer.query(confirmCall.getCallResultSummary, f.meeting)).resolves.toMatchObject({
      kind: "refusal_loss", meetingHeld: true, task: null, lossReason: LABEL,
      byline: `confirmed by ${role === "closer" ? "Kim" : "Jordan"}`,
      can: { changeNextStep: false, withdrawAttendance: false, undo: false, reopen: true },
    });
    await expect(f.other.mutation(refusal.reopenRefusal, { decisionId: f.args.decisionId }))
      .resolves.toEqual({ ok: false, code: "not_yours" });
    const reopenArgs = { decisionId: f.args.decisionId };
    vi.setSystemTime(NOW + 1);
    await expect(actor.mutation(refusal.reopenRefusal, reopenArgs)).resolves.toEqual({ ok: true, alreadyApplied: false });
    await checkInvariants(f);
    await expect(actor.mutation(refusal.reopenRefusal, reopenArgs)).resolves.toEqual({ ok: true, alreadyApplied: true });
    await checkInvariants(f);

    await f.t.run(async (ctx) => {
      const deal = await ctx.db.get("opportunities", f.opportunityId);
      const meeting = await ctx.db.get("meetings", f.meetingId);
      expect(deal).toMatchObject({ stage: "follow_up", outcome: "open", humanResultRevision: 2 });
      expect(deal?.lostReason).toBeUndefined();
      expect(deal?.lostAt).toBeUndefined();
      expect(deal?.lostByUserId).toBeUndefined();
      expect(meeting).toMatchObject({ status: "held", heldMarkedAt: NOW });
      expect(await ctx.db.query("followUps").take(2)).toMatchObject([{
        status: "pending", purpose: "call_back", contactMethod: "call", reason: "call_insights",
        closerId: f.closerId, createdByUserId: actorId, reminderScheduledAt: NOW + 1, automationDecisionId: f.args.decisionId,
      }]);
      expect(await ctx.db.query("closerPinnedLines").take(2)).toMatchObject([{
        kind: "refusal_reopened", userId: f.closerId, dealPositionAfter: "follow_up", decisionId: f.args.decisionId,
      }]);
      expect(await ctx.db.get("resultAutomationDecisions", f.args.decisionId)).toMatchObject({
        state: "undone", resolvedAt: NOW, resolvedByUserId: actorId,
      });
    });
  });

  it("lets an admin close a pending notice as a person-confirmed result", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.patch("resultAutomationDecisions", f.args.decisionId, {
      state: "notice", mode: "automatic", noticeRound: 1, sampleId: undefined,
    }));
    await checkInvariants(f);
    await expect(f.closer.query(confirmCall.getCallAsk, f.meeting)).resolves.toMatchObject({
      state: "notice", notice: { round: 1, hours: 48 }, can: {
        confirm: true, decline: false, acknowledge: true, stop: true,
      },
    });
    let elapsed = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => NOW + elapsed++);
    try {
      await expect(f.admin.mutation(refusal.confirmRefusal, f.args)).resolves.toMatchObject({
        ok: true, alreadyApplied: false,
      });
    } finally {
      clock.mockRestore();
    }
    await checkInvariants(f);
    await expect(f.admin.query(confirmCall.getCallResultSummary, f.meeting)).resolves.toMatchObject({
      entry: "confirmed", resolvedByUserId: f.adminId, can: { undo: false, reopen: true },
    });
    await expect(f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", f.args.decisionId)))
      .resolves.toMatchObject({ mode: "ask", state: "applied", appliedVia: "meeting_confirm" });
  });

  it("counts the refusal as Lost and masks its reason on screen and in both export reads", async () => {
    const f = await fixture();
    await expect(f.closer.mutation(refusal.confirmRefusal, f.args)).resolves.toMatchObject({ ok: true });
    await checkInvariants(f);
    const logArgs = { ...RANGE, paginationOpts: { numItems: 50, cursor: null } };
    const readers = await Promise.all([
      f.admin.query(api.reporting.teamOutcomes.getTeamOutcomeMix, RANGE),
      f.closer.query(api.closer.endOfDay.getDaySummary, { now: NOW + 1, timeZone: "America/Tegucigalpa" }),
      f.closer.query(api.closer.dashboard.getPipelineSummary, RANGE),
      f.closer.query(api.closer.meetingDetail.getMeetingDetail, f.meeting),
      f.closer.query(confirmCall.getCallResultSummary, f.meeting),
      f.admin.query(api.reporting.activityFeed.getActivityFeed, logArgs),
      f.admin.query(api.reports.log.listLog, logArgs),
    ]);
    const [mix, day, pipeline, detail, receipt, activity, log] = readers;
    const lossEvent = expect.objectContaining({ eventType: "opportunity.marked_lost", reason: LABEL });
    expect(activity.page).toContainEqual(lossEvent);
    expect(log.page).toContainEqual(lossEvent);
    expect(mix).toMatchObject({ teamOutcome: { lost: 1 }, derived: { lostDeals: 1 } });
    expect(mix.closerOutcomes).toContainEqual(expect.objectContaining({
      closerId: f.closerId, outcomes: expect.objectContaining({ lost: 1 }),
    }));
    expect(day.numbers.deals.lost).toBe(1);
    expect(day.numbers.people).toMatchObject([{ kind: "lost", name: "Grace" }]);
    expect(pipeline.decided).toEqual({ won: 0, lost: 1 });
    expect(detail.opportunity).toMatchObject({ outcome: "lost", lostReason: LABEL });
    expect(receipt).toMatchObject({ lossReason: LABEL, byline: "confirmed by Kim" });
    expect(JSON.stringify(readers)).not.toContain("call_refusal");
    const deal = await f.t.run((ctx) => ctx.db.get("opportunities", f.opportunityId));
    expect(deal && isPersonLoss(deal)).toBe(true);

    const range = {
      startDate: "2026-11-16", endDateInclusive: "2026-11-17",
      fromMs: RANGE.startDate, toMs: RANGE.endDate, timeZone: "America/Tegucigalpa", dayStartHour: 0,
    };
    const live = await f.admin.query(internal.reports.rowsExport.liveEventPage, { range, cursor: null });
    expect(live.rows).toContainEqual(expect.objectContaining({ eventType: "opportunity.marked_lost", reason: LABEL }));
    const warehouse = exportRowsFromSql("events", [
      { event_type: "opportunity.marked_lost", reason: "call_refusal" },
      { event_type: "opportunity.marked_lost", reason: "Could not reach agreement" },
    ], range.timeZone);
    expect(warehouse.map(({ reason }) => reason)).toEqual([LABEL, "Could not reach agreement"]);
    expect(JSON.stringify([live, warehouse])).not.toContain("call_refusal");
  });

  it("refuses reopen after a conflicting human result, including for an owner", async () => {
    const f = await fixture();
    await expect(f.closer.mutation(refusal.confirmRefusal, f.args)).resolves.toMatchObject({ ok: true });
    await checkInvariants(f);
    await f.t.run((ctx) => noteHumanResult(ctx, f.opportunityId, { tenantId: f.tenantId, userId: f.adminId }));
    for (const actor of [f.closer, f.owner]) {
      await expect(actor.mutation(refusal.reopenRefusal, { decisionId: f.args.decisionId }))
        .resolves.toEqual({ ok: false, code: "needs_review" });
    }
    await expect(f.owner.query(confirmCall.getCallResultSummary, f.meeting)).resolves.toMatchObject({ can: { reopen: false } });
    await checkInvariants(f);
  });

  it("refuses an unrelated human loss with the same words", async () => {
    const f = await fixture();
    await f.closer.mutation(api.closer.meetingActions.markAsLost, {
      meetingId: f.meetingId, opportunityId: f.opportunityId, reason: LABEL,
    });
    await expect(f.admin.mutation(refusal.reopenRefusal, { decisionId: f.args.decisionId })).resolves.toEqual({
      ok: false, code: "not_ready",
    });
    const deal = await f.t.run((ctx) => ctx.db.get("opportunities", f.opportunityId));
    expect(deal).toMatchObject({ outcome: "lost", lostReason: LABEL });
    await checkInvariants(f);
  });
});
