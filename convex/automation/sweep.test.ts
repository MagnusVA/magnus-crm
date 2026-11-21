import type { FunctionArgs } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import {
  automationFixtureApi, automationPaymentFixture, FIXTURE_NOW, insertProviderFact, setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";
import { MAX_PROVIDER_PAYMENT_AGE_MS } from "../payments/reviewTiming";
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

  async function pendingJobs(f: Awaited<ReturnType<typeof automationPaymentFixture>>) {
    return await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(100));
  }

  it("skips aged paid history and saves its place among recent candidates", async () => {
    const f = await automationPaymentFixture({
      fact: { externalPaymentId: "pay_zzz", reviewState: "needs_person" },
    });
    await f.t.run(async (ctx) => {
      await setPaymentFixtureModes(ctx, f);
      const paidAt = FIXTURE_NOW - MAX_PROVIDER_PAYMENT_AGE_MS - 2 * 86_400_000;
      for (let index = 0; index < 2_000; index++) {
        await insertProviderFact(ctx, f.tenantId, f.connectionId, {
          externalPaymentId: `aged_${index}`, paidAt, sourceCreatedAt: paidAt,
          reviewState: "needs_person",
        });
      }
      for (let index = 0; index < 22; index++) {
        await insertProviderFact(ctx, f.tenantId, f.connectionId, {
          externalPaymentId: `fresh_${index}`, paidAt: FIXTURE_NOW - 60_000,
          sourceCreatedAt: FIXTURE_NOW - 60_000, reviewState: "needs_person",
        });
      }
    });
    await f.t.mutation(automationFixtureApi.sweep.run, {});
    const page = (await pendingJobs(f)).find((job) => job.name.endsWith("connectionPage"));
    expect(page).toBeDefined();
    await f.t.mutation(automationFixtureApi.sweep.connectionPage,
      page!.args[0] as FunctionArgs<typeof automationFixtureApi.sweep.connectionPage>);
    const evaluators = (await pendingJobs(f)).filter((job) => job.name.endsWith("evaluateProviderPayment"));
    expect(evaluators).toHaveLength(20);
    const evaluated = await f.t.run(async (ctx) => await Promise.all(evaluators.map((job) =>
      ctx.db.get("providerPayments", (job.args[0] as FunctionArgs<typeof automationFixtureApi.decisions.evaluateProviderPayment>).providerPaymentId))));
    expect(evaluated.every((payment) => payment && !payment.externalPaymentId.startsWith("aged_"))).toBe(true);
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await pendingJobs(f)).filter((job) => job.name.endsWith("evaluateProviderPayment"))).toHaveLength(20);
    vi.setSystemTime(FIXTURE_NOW + 15 * 60_000);
    await f.t.mutation(automationFixtureApi.sweep.run, {});
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await pendingJobs(f)).filter((job) => job.name.endsWith("evaluateProviderPayment"))).toHaveLength(23);
  });

  it("stops a queued payment continuation when both payment kinds are switched off", async () => {
    const f = await automationPaymentFixture({ fact: { reviewState: "needs_person" } });
    await f.t.run(async (ctx) => {
      await setPaymentFixtureModes(ctx, f);
      for (let index = 0; index < 21; index++) {
        await insertProviderFact(ctx, f.tenantId, f.connectionId, {
          externalPaymentId: `pay_${index}`, reviewState: "needs_person",
        });
      }
    });
    await f.t.mutation(automationFixtureApi.sweep.run, {});
    const page = (await pendingJobs(f)).find((job) => job.name.endsWith("connectionPage"));
    expect(page).toBeDefined();
    await f.t.run(async (ctx) => {
      const { resultAutomation: settings } = (await ctx.db.get("tenants", f.tenantId))!;
      await ctx.db.patch("tenants", f.tenantId, {
        resultAutomation: {
          ...settings!,
          kinds: {
            ...settings!.kinds,
            payment_win: { ...settings!.kinds.payment_win, mode: "off" },
            additional_payment: { ...settings!.kinds.additional_payment, mode: "off" },
          },
        },
      });
    });
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await pendingJobs(f)).filter((job) => job.name.endsWith("connectionPage"))).toHaveLength(1);
    expect((await pendingJobs(f)).filter((job) => job.name.endsWith("evaluateProviderPayment"))).toHaveLength(0);
  });

  it("repairs a stranded decision even after its dismissed payment ages out of the repair band", async () => {
    const f = await automationPaymentFixture({ fact: { reviewState: "needs_person" } });
    const { decisionId } = await f.t.run(async (ctx) => {
      await setPaymentFixtureModes(ctx, f);
      const result = await evaluateSubject(ctx, { ...f, now: FIXTURE_NOW, cause: "provider_read" });
      expect(await ctx.db.get("resultAutomationDecisions", result.decisionId!)).toMatchObject({ state: "ready" });
      await ctx.db.patch("providerPayments", f.providerPaymentId, { reviewState: "dismissed" });
      return result;
    });
    vi.setSystemTime(FIXTURE_NOW + MAX_PROVIDER_PAYMENT_AGE_MS + 2 * 86_400_000);
    await f.t.mutation(automationFixtureApi.sweep.run, {});
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", decisionId!)))
      .toMatchObject({ state: "superseded" });
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
