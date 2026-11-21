import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPaymentInvariants, seedProviderWin } from "../../tests/paymentInvariants";
import {
  automationFixtureApi, automationPaymentFixture, FIXTURE_NOW, FIXTURE_PAID_AT,
  insertProviderDeal, insertProviderFact, insertProviderMeeting, insertProviderPerson, seedReadyDecision, setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";
import { insertMeetingAggregate } from "../reporting/writeHooks";
import { evaluateSubject } from "./decisions";
import { currentRuleVersion } from "./settings";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("getAutomationScorecard", () => {
  it("reports windows, routes, attendance, unresolved flags and Whop freshness", async () => {
    const f = await automationPaymentFixture({ fact: { reviewState: "needs_person" } });
    await f.t.run(async (ctx) => {
      await setPaymentFixtureModes(ctx, f);
      const meeting = (opportunityId: NonNullable<typeof f.dealId>, scheduledAt: number) =>
        ctx.db.insert("meetings", {
          tenantId: f.tenantId, opportunityId, assignedCloserId: f.closerId, scheduledAt,
          durationMinutes: 30, status: "scheduled", createdAt: scheduledAt,
          calendlyEventUri: `https://api.calendly.com/scheduled_events/${scheduledAt}`,
          calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${scheduledAt}/invitees/x`,
        });
      await insertMeetingAggregate(ctx, await meeting(f.dealId!, FIXTURE_NOW - 60_000));
      await evaluateSubject(ctx, { ...f, cause: "sweep", now: FIXTURE_NOW });
      await insertProviderFact(ctx, f.tenantId, f.connectionId, {
        externalPaymentId: "pay_billing", reviewState: "needs_person", payerEmail: "partner@example.com",
        notMySaleAt: FIXTURE_NOW - 1, firstSeenAt: FIXTURE_NOW - 5000,
      });

      const leadId = await insertProviderPerson(ctx, f.tenantId, { email: "won@example.com" });
      const opportunityId = await insertProviderDeal(ctx, { tenantId: f.tenantId, leadId, assignedCloserId: f.closerId });
      const providerPaymentId = await insertProviderFact(ctx, f.tenantId, f.connectionId, { externalPaymentId: "pay_won" });
      await insertMeetingAggregate(ctx, await meeting(opportunityId, FIXTURE_NOW - 3_600_000));
      await insertMeetingAggregate(ctx, await meeting(opportunityId, FIXTURE_NOW + 3_600_000));
      await seedProviderWin(ctx, { ...f, opportunityId, providerPaymentId, approverId: f.adminId, recordedAt: FIXTURE_PAID_AT });
    });
    const fn = automationFixtureApi.scorecard.getAutomationScorecard;
    const result = await f.admin.query(fn, { windowDays: 7 });
    expect(result).toMatchObject({
      kinds: {
        payment_win: {
          proposed: { count: 1, capped: false }, leftForPerson: { count: 0 }, graded: { count: 0 },
          wrong: { count: 0 }, ungraded: { count: 1, oldestAt: FIXTURE_NOW }, corrected: { count: 0 },
          shareOfPaidWhopPayments: 1 / 3,
        },
        additional_payment: { proposed: { count: 0 }, shareOfPaidWhopPayments: 0 },
      },
      paidWhopPayments: { count: 3, capped: false },
      winsAwaitingAttendance: { count: 1, oldestAt: FIXTURE_NOW - 1_800_000 },
      paymentsWaiting: { count: 2, oldestAt: FIXTURE_NOW - 5000, closer: { count: 1 }, billing: { count: 1 } },
      unansweredNotMySale: { count: 1, capped: false },
      freshness: { lastWebhookAt: null, lastSuccessfulSweepAt: FIXTURE_NOW - 1000 },
    });
    await expect(f.closer.query(fn, { windowDays: 7 })).rejects.toThrow("Insufficient permissions");
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("reports call proposals, closer stops, refusal notices, overdue tasks, and calls without a Second opinion", async () => {
    const f = await automationPaymentFixture();
    await f.t.run(async (ctx) => {
      const tenant = (await ctx.db.get("tenants", f.tenantId))!;
      const opportunityId = f.dealId!;
      const meeting = async (scheduledAt: number) => await insertProviderMeeting(ctx, { ...f, opportunityId, scheduledAt });
      const meetingId = await meeting(FIXTURE_NOW - 3_600_000);
      const otherDueMeetingId = await meeting(FIXTURE_NOW - 7_200_000);
      await meeting(FIXTURE_NOW + 3_600_000);
      const inProgress = await meeting(FIXTURE_NOW - 1_000);
      const canceled = await meeting(FIXTURE_NOW - 10_800_000);
      await ctx.db.patch("meetings", canceled, { status: "canceled" });

      const call = async (kind: "call_back" | "payment_owed" | "refusal_loss", tag: string) =>
        await seedReadyDecision(ctx, {
          tenantId: f.tenantId, kind, opportunityId, leadId: f.personId, meetingId,
          assignedCloserId: f.closerId, noticeUserId: f.closerId,
          ruleVersion: currentRuleVersion(tenant, kind), inputKey: tag,
        });
      const applied = await call("call_back", "fixture-applied");
      await ctx.db.patch("resultAutomationDecisions", applied, { mode: "automatic", state: "applied",
        appliedVia: "automatic", resolvedAt: FIXTURE_NOW - 1000 });
      await ctx.db.patch("resultAutomationDecisions", await call("call_back", "fixture-duplicate"), {
        state: "stopped", stopCode: "person_stop", resolvedAt: FIXTURE_NOW,
        grade: { verdict: "wrong", gradedAt: FIXTURE_NOW, gradedByUserId: f.adminId, gradedBeforeSeeing: true, wrongFields: ["person"] },
      });
      await ctx.db.patch("resultAutomationDecisions", await call("payment_owed", "fixture-abstention"), {
        wouldWrite: false, state: "needs_person",
      });
      await ctx.db.patch("resultAutomationDecisions", await call("payment_owed", "fixture-in-progress"), {
        meetingId: inProgress,
      });
      for (const [tag, fields] of [
        ["open", { state: "notice" }],
        ["seen", { state: "notice", acknowledgedAt: FIXTURE_NOW }],
        ["stopped", { state: "stopped", stopCode: "person_stop", resolvedAt: FIXTURE_NOW }],
      ] as const) {
        await ctx.db.patch("resultAutomationDecisions", await call("refusal_loss", tag), {
          ...fields, noticeRound: 1, mode: "automatic", meetingId: otherDueMeetingId,
        });
      }
      const task = {
        tenantId: f.tenantId, opportunityId, leadId: f.personId, closerId: f.closerId,
        type: "manual_reminder" as const, reason: "call_insights" as const, status: "pending" as const,
        automationDecisionId: applied, createdAt: FIXTURE_NOW - 5_000,
        reminderScheduledAt: FIXTURE_NOW - 1_000,
      };
      await ctx.db.insert("followUps", { ...task, createdSource: "system" });
      await ctx.db.insert("followUps", { ...task, createdSource: "closer" });
      await ctx.db.insert("followUps", { ...task, createdSource: "system", reminderScheduledAt: FIXTURE_NOW + 1000 });
    });
    const result = await f.admin.query(automationFixtureApi.scorecard.getAutomationScorecard, { windowDays: 7 });
    expect(result).toMatchObject({
      kinds: {
        call_back: { proposed: { count: 2, partial: false }, graded: { count: 1 }, wrong: { count: 1 }, shareOfCallsDue: 0.5 },
        payment_owed: { leftForPerson: { count: 1 }, shareOfCallsDue: 0 },
        refusal_loss: { proposed: { count: 3 }, shareOfCallsDue: 0.5 },
      },
      callsDue: { count: 2, partial: false },
      closerActivity: { partial: false, rows: [{
        closerId: f.closerId,
        stops: { count: 2 },
        unacknowledgedRefusalNotices: { count: 1 },
        stoppedRefusalNotices: { count: 1 },
      }] },
      automaticTasksOverdue: { count: 1, partial: false },
      automaticCallsWithoutSecondOpinion: { count: 1, partial: false },
    });
  });

  it("marks the automatic overdue count partial at its cap", async () => {
    const f = await automationPaymentFixture();
    await f.t.run(async (ctx) => {
      const task = {
        tenantId: f.tenantId, opportunityId: f.dealId!, leadId: f.personId, closerId: f.closerId,
        type: "manual_reminder" as const, reason: "call_insights" as const, status: "pending" as const,
        createdSource: "system" as const, createdAt: FIXTURE_NOW - 2000, reminderScheduledAt: FIXTURE_NOW - 1_000,
      };
      for (let i = 0; i < 501; i++) await ctx.db.insert("followUps", task);
    });
    const result = await f.admin.query(automationFixtureApi.scorecard.getAutomationScorecard, { windowDays: 7 });
    expect(result).toMatchObject({ automaticTasksOverdue: { count: 500, partial: true } });
  });

  it("reports a lower bound when a capped range cannot be read in full", async () => {
    const f = await automationPaymentFixture();
    for (let offset = 0; offset <= 500; offset += 100) {
      await f.t.run(async (ctx) => {
        for (let i = offset; i <= Math.min(500, offset + 99); i++) {
          await insertProviderFact(ctx, f.tenantId, f.connectionId, {
            externalPaymentId: `pay_flagged_${i}`, notMySaleAt: FIXTURE_NOW,
          });
        }
      });
    }
    const result = await f.admin.query(automationFixtureApi.scorecard.getAutomationScorecard, { windowDays: 7 });
    expect(result.unansweredNotMySale).toEqual({ count: 500, capped: true });
    expect(result.paidWhopPayments).toEqual({ count: 500, capped: true });
    expect(result.kinds.payment_win.shareOfPaidWhopPayments).toBeNull();
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId, providerPaymentIds: [f.providerPaymentId] });
  });
});
