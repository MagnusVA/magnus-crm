import { anyApi, type ApiFromModules } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertAutomationInvariants } from "../../tests/automationInvariants";
import {
  automationFixtureApi, automationPaymentFixture, FIXTURE_NOW, insertProviderPerson, seedAppliedReceipt,
  seedReadyDecision, setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";
import { sha256Hex } from "../lib/stableHash";
import { scheduleAudit } from "./audit";
import { assertAutomaticAllowed, WHOP_FRESH_MS } from "./breaker";
import { evaluateSubject } from "./decisions";

const { certificates, audit, breaker } = (anyApi as unknown as ApiFromModules<{
  "automation/certificates": typeof import("./certificates");
  "automation/audit": typeof import("./audit");
  "automation/breaker": typeof import("./breaker");
}>).automation;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function fixture() {
  const f = await automationPaymentFixture();
  const evidence = {
    allocationRevision: 0, sourceUpdatedAt: FIXTURE_NOW,
    bindingIds: [f.productBindingId, f.variantBindingId], bindingVersions: [1, 1],
  };
  await f.t.run((ctx) => setPaymentFixtureModes(ctx, f));
  for (let offset = 0; offset < 300; offset += 100) {
    await f.t.run(async (ctx) => {
      for (let i = offset; i < offset + 100; i++) {
        await seedReadyDecision(ctx, {
          tenantId: f.tenantId, leadId: await insertProviderPerson(ctx, f.tenantId, { email: `sample-${i}@example.com` }),
          inputKey: await sha256Hex(`payment sample:${i}`), evidence,
        });
      }
    });
  }
  const sampleId = (await f.owner.mutation(certificates.openSample, { kind: "payment_win" }))!;
  await f.t.run(async (ctx) => {
    const members = await ctx.db.query("resultAutomationDecisions").withIndex("by_tenantId_and_sampleId_and_leadId", (q) =>
      q.eq("tenantId", f.tenantId).eq("sampleId", sampleId)).take(301);
    for (const { _id } of members) {
      await ctx.db.patch("resultAutomationDecisions", _id, {
        grade: { verdict: "correct", gradedAt: FIXTURE_NOW, gradedByUserId: f.ownerId, gradedBeforeSeeing: true, wrongFields: [] },
      });
    }
  });
  expect(await f.owner.mutation(certificates.certify, { sampleId })).toEqual({ ok: true });
  expect(await f.owner.mutation(certificates.promoteKind, { kind: "payment_win", sampleId })).toMatchObject({ ok: true });
  const automaticId = (await f.t.run((ctx) => evaluateSubject(ctx, { ...f, cause: "sweep", now: FIXTURE_NOW }))).decisionId!;
  const decision = (await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", automaticId)))!;
  expect(decision).toMatchObject({ state: "ready", mode: "automatic", dueAt: FIXTURE_NOW + 15 * 60_000 });
  const gate = (fields = {}) => f.t.run((ctx) => assertAutomaticAllowed(ctx, {
    tenantId: f.tenantId, kind: "payment_win", decision: { ...decision, ...fields },
  }));
  const write = () => f.t.run(async (ctx) => {
    const id = await seedAppliedReceipt(ctx, {
      tenantId: f.tenantId, policyVersion: decision.policyVersion,
      appliedVia: "automatic", certificateSampleId: sampleId, evidence,
    });
    await ctx.db.patch("resultAutomationDecisions", id, { mode: "automatic" });
    await scheduleAudit(ctx, (await ctx.db.get("resultAutomationDecisions", id))!);
    return id;
  });
  return { ...f, gate, write, sampleId };
}

it("trips for a wrong person and requires an owner reset before writes can resume", async () => {
  const f = await fixture();
  expect(await f.gate()).toEqual({ ok: true, sampleId: f.sampleId });
  const decisionId = await f.write();
  const args = { decisionId, verdict: "wrong", wrongFields: ["person"] } as const;
  await expect(f.closer.mutation(audit.recordAudit, { ...args, wrongFields: ["person"] })).rejects.toThrow("Insufficient permissions");
  expect(await f.admin.mutation(audit.recordAudit, { ...args, wrongFields: ["person"] })).toEqual({ ok: true, alreadyApplied: false });
  expect(await f.admin.mutation(audit.recordAudit, { ...args, wrongFields: ["person"] })).toEqual({ ok: true, alreadyApplied: true });
  expect(await f.gate()).toMatchObject({ ok: false, gate: "kind_off" });
  expect((await f.owner.query(automationFixtureApi.settings.getSettings, {})).automatic.payment_win.breaker)
    .toMatchObject({ reason: "wrong_write", decisionId });
  await expect(f.admin.mutation(breaker.resetBreaker, { kind: "payment_win" })).rejects.toThrow("Insufficient permissions");
  expect(await f.owner.mutation(breaker.resetBreaker, { kind: "payment_win" })).toEqual({ ok: true, alreadyApplied: false });
  expect(await f.gate()).toMatchObject({ ok: false, gate: "kind_off" });
  await assertAutomationInvariants(f.t, f);
});

it("holds the audited product for a wrong program and keeps the kind automatic", async () => {
  const f = await fixture();
  const decisionId = await f.write();
  await f.admin.mutation(audit.recordAudit, { decisionId, verdict: "wrong", wrongFields: ["program"] });
  const [product, variant] = await f.t.run((ctx) => Promise.all([
    ctx.db.get("paymentProviderBindings", f.productBindingId), ctx.db.get("paymentProviderBindings", f.variantBindingId),
  ]));
  expect(product).toMatchObject({ automaticHeldDecisionId: decisionId, automaticHeldAt: FIXTURE_NOW });
  expect(variant?.automaticHeldAt).toBeUndefined();
  expect(await f.gate()).toMatchObject({ ok: false, gate: "mapping_held" });
  const view = await f.owner.query(automationFixtureApi.settings.getSettings, {});
  expect(view.effective.payment_win).toBe("automatic");
  expect(view.breakers).toEqual([]);
  const replacement = await f.t.run(async (ctx) => {
    const { decisionId } = await evaluateSubject(ctx, { ...f, cause: "sweep", now: FIXTURE_NOW });
    return await ctx.db.get("resultAutomationDecisions", decisionId!);
  });
  expect(replacement).toMatchObject({ mode: "ask", state: "ready", wouldWrite: false, gates: ["mapping_held"] });
  expect(replacement?.dueAt).toBeUndefined();
  await assertAutomationInvariants(f.t, f);
});

it("waits on Whop freshness, refuses stale certificates and paused tenants, and trips both payment kinds for a late flag", async () => {
  const f = await fixture();
  const sweep = () => f.t.mutation(automationFixtureApi.sweep.run, {});
  expect(await f.gate({ ruleVersion: "payment-rule@0" })).toMatchObject({ ok: false, gate: "certificate_lapsed" });
  await f.admin.mutation(automationFixtureApi.settings.setEnabled, { enabled: false });
  expect(await f.gate()).toMatchObject({ ok: false, gate: "kind_off" });
  await f.owner.mutation(automationFixtureApi.settings.setEnabled, { enabled: true });
  vi.setSystemTime(FIXTURE_NOW + WHOP_FRESH_MS);
  expect(await f.gate({ activationVersion: 3 })).toMatchObject({ ok: false, gate: "whop_stale" });
  expect((await f.owner.query(automationFixtureApi.settings.getSettings, {})).automatic.payment_win)
    .toMatchObject({ breaker: null, automaticBlockedReason: "whop_stale" });

  await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, {
    notMySaleAt: FIXTURE_NOW, notMySaleByUserId: f.closerId,
  }));
  vi.setSystemTime(FIXTURE_NOW + 86_400_000 - 1);
  await sweep();
  expect((await f.owner.query(automationFixtureApi.settings.getSettings, {})).breakers).toEqual([]);
  vi.setSystemTime(FIXTURE_NOW + 86_400_000);
  await sweep();
  const view = await f.owner.query(automationFixtureApi.settings.getSettings, {});
  expect(view.breakers.map(({ kind, reason }) => [kind, reason])).toEqual([
    ["payment_win", "not_my_sale_unanswered"], ["additional_payment", "not_my_sale_unanswered"],
  ]);
  expect(await f.gate({ activationVersion: 3 })).toMatchObject({ ok: false, gate: "kind_off" });
  expect(await f.owner.mutation(breaker.resetBreaker, { kind: "payment_win" })).toEqual({ ok: false, code: "needs_review" });
  expect((await f.owner.query(automationFixtureApi.scorecard.getAutomationScorecard, { windowDays: 7 })).breakers).toEqual(view.breakers);
  await assertAutomationInvariants(f.t, f);
});
