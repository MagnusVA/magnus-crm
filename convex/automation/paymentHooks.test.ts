import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertAutomationInvariants } from "../../tests/automationInvariants";
import { callInsightsHarness, seedCallDecisionReading } from "../../tests/callInsightsHarness";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import { insertPaymentFixtureConnection, insertProviderFact, insertProviderPerson } from "../../tests/providerPaymentFixtures";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { evaluateSubject, scheduleEvaluation } from "./decisions";

const NOW = Date.parse("2026-11-17T19:00:00Z");
const evaluateCallMeeting = makeFunctionReference<"mutation", { meetingId: Id<"meetings">; cause: "published" }>(
  "automation/callDecisions:evaluateCallMeeting",
);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(["intake", "evaluate"] as const)("a Whop payment for the person stops the refusal and alert via %s", async (path) => {
  const f = await callInsightsHarness();
  await f.owner.mutation(api.automation.settings.setEnabled, { enabled: true });
  await f.owner.mutation(api.automation.settings.setKindMode, { kind: "refusal_loss", mode: "ask" });
  await f.owner.mutation(api.automation.settings.setAlertMode, { mode: "on", graceMinutes: 30 });
  const reading = await seedCallDecisionReading(f, { kind: "refusal_loss", alert: true });
  await f.t.mutation(internal.callInsights.run.publish, reading);
  await f.t.mutation(evaluateCallMeeting, { meetingId: f.meetingId, cause: "published" });

  const rows = () => f.t.run((ctx) => ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_meetingId", (q) => q.eq("tenantId", f.tenantId).eq("meetingId", f.meetingId)).take(10));
  const [refusal] = await rows();
  const refusalState = path === "intake" ? "ready" : "notice";
  if (refusalState === "notice") {
    await f.t.run((ctx) => ctx.db.patch("resultAutomationDecisions", refusal._id, {
      mode: "automatic", state: "notice", noticeRound: 1,
    }));
  }
  expect(await rows()).toMatchObject([
    { kind: "refusal_loss", state: refusalState },
    { kind: "paid_on_call_alert", state: "ready" },
  ]);

  const connectionId = await f.t.run((ctx) => insertPaymentFixtureConnection(ctx, f.tenantId, f.ownerId));
  const evaluate = (providerPaymentId: Id<"providerPayments">) => f.t.run(async (ctx) => {
    if (path === "intake") await scheduleEvaluation(ctx, providerPaymentId, "provider_read");
    else await evaluateSubject(ctx, { tenantId: f.tenantId, providerPaymentId, cause: "provider_read", now: NOW });
  });
  const unrelated = await f.t.run(async (ctx) => {
    const otherLead = await insertProviderPerson(ctx, f.tenantId);
    return await insertProviderFact(ctx, f.tenantId, connectionId, {
      externalPaymentId: "pay_other", candidateLeadId: otherLead, reviewState: "needs_person",
    });
  });
  await evaluate(unrelated);
  expect((await rows()).map((row) => row.state)).toEqual([refusalState, "ready"]);
  await assertAutomationInvariants(f.t, { tenantId: f.tenantId });
  await assertPaymentInvariants(f.t, { tenantId: f.tenantId });

  const providerPaymentId = await f.t.run((ctx) => insertProviderFact(ctx, f.tenantId, connectionId, {
    candidateLeadId: f.leadId, reviewState: "needs_person", paidAt: NOW - 5000,
  }));
  await evaluate(providerPaymentId);
  expect(await rows()).toMatchObject([
    { kind: "refusal_loss", state: "stopped", stopCode: "payment_found" },
    { kind: "paid_on_call_alert", state: "stopped", stopCode: "payment_found" },
  ]);
  await evaluate(providerPaymentId);
  expect(await rows()).toHaveLength(2);

  await assertAutomationInvariants(f.t, { tenantId: f.tenantId });
  await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
});
