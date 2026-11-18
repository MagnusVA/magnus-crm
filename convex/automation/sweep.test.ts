import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import {
  automationFixtureApi, automationPaymentFixture, FIXTURE_NOW, insertProviderFact, setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";
import { evaluateSubject } from "./decisions";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("Whop decision repair", () => {
  it("continues across a full page and repairs only actionable subjects on enabled tenants", async () => {
    const enabled = await automationPaymentFixture({ fact: { externalPaymentId: "pay_zzz", reviewState: "needs_person" } });
    await enabled.t.run(async (ctx) => {
      await setPaymentFixtureModes(ctx, enabled);
      for (let index = 0; index < 22; index++) {
        await insertProviderFact(ctx, enabled.tenantId, enabled.connectionId, {
          externalPaymentId: `pay_${index}`, status: "pending",
        });
      }
    });
    await enabled.t.mutation(automationFixtureApi.sweep.run, {});
    await enabled.t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await enabled.t.run((ctx) => ctx.db.query("resultAutomationDecisions").take(5));
    expect(rows).toMatchObject([{ providerPaymentId: enabled.providerPaymentId, state: "ready" }]);
    await assertPaymentInvariants(enabled.t, { tenantId: enabled.tenantId });

    const disabled = await automationPaymentFixture();
    await disabled.t.mutation(automationFixtureApi.sweep.run, {});
    await disabled.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await disabled.t.run((ctx) => ctx.db.query("resultAutomationDecisions").first())).toBeNull();
    await assertPaymentInvariants(disabled.t, { tenantId: disabled.tenantId });
  });

  it("moves a Billing ask to the meeting when the call starts", async () => {
    const f = await automationPaymentFixture();
    const meetingId = await f.t.run(async (ctx) => {
      await setPaymentFixtureModes(ctx, f);
      return await ctx.db.insert("meetings", {
        tenantId: f.tenantId, opportunityId: f.dealId!, scheduledAt: FIXTURE_NOW + 60_000,
        assignedCloserId: f.closerId, durationMinutes: 30, status: "scheduled", createdAt: FIXTURE_NOW,
        calendlyEventUri: "https://api.calendly.com/scheduled_events/fixture",
        calendlyInviteeUri: "https://api.calendly.com/scheduled_events/fixture/invitees/x",
      });
    });
    await f.t.run((ctx) => evaluateSubject(ctx, { ...f, now: FIXTURE_NOW, cause: "provider_read" }));
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    vi.setSystemTime(FIXTURE_NOW + 60_000);
    await f.t.mutation(automationFixtureApi.sweep.run, {});
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await f.t.run((ctx) => ctx.db.query("resultAutomationDecisions").take(5));
    expect(rows).toMatchObject([
      { state: "superseded", confirmRoute: "billing" },
      { state: "ready", confirmRoute: "meeting", noticeUserId: f.closerId, meetingId },
    ]);
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });
});
