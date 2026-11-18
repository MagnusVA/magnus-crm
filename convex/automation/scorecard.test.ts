import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPaymentInvariants, seedProviderWin } from "../../tests/paymentInvariants";
import {
  automationFixtureApi, automationPaymentFixture, FIXTURE_NOW, FIXTURE_PAID_AT,
  insertProviderDeal, insertProviderFact, insertProviderPerson, setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";
import { insertMeetingAggregate } from "../reporting/writeHooks";
import { evaluateSubject } from "./decisions";

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
