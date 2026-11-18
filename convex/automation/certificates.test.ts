import { anyApi, type ApiFromModules } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { assertAutomationInvariants } from "../../tests/automationInvariants";
import {
  automationFixtureApi, automationPaymentFixture, FIXTURE_NOW, insertProviderBinding, insertProviderPerson, seedReadyDecision,
  paymentConfirmationFixture, seedAutomaticCertificate, setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";
import { initialSettings as initialCallSettings } from "../callInsights/settings";
import { applyProviderPayment, previewProviderApply } from "../payments/apply";
import { sha256Hex } from "../lib/stableHash";
import type { AutomationKind } from "./proposals";
import { assertAutomaticAllowed } from "./breaker";
import { CASE_MAX_AGE_MS, CERTIFICATE_TARGET, enrollInSample } from "./certificates";
import { evaluateSubject } from "./decisions";
import { currentRuleVersion, effectiveKindMode } from "./settings";

const certificates = (anyApi as unknown as ApiFromModules<{
  "automation/certificates": typeof import("./certificates");
}>).automation.certificates;
const { settings, grading } = automationFixtureApi;
type Fixture = Awaited<ReturnType<typeof automationPaymentFixture>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function fixture(kind: AutomationKind = "payment_win") {
  const f = await automationPaymentFixture();
  await f.t.run((ctx) => setPaymentFixtureModes(ctx, f));
  if (kind !== "payment_win" && kind !== "additional_payment") {
    await f.owner.mutation(settings.setKindMode, { kind, mode: "ask" });
    await f.t.run((ctx) => ctx.db.patch("tenants", f.tenantId, { callInsights: initialCallSettings(f.ownerId, FIXTURE_NOW) }));
  }
  return f;
}

async function seed(
  f: Fixture, count: number, options: {
    kind?: AutomationKind; wouldWrite?: boolean; reusePerson?: boolean; createdAt?: number; grade?: "correct";
  } = {},
) {
  const kind = options.kind ?? "payment_win";
  const ids: Id<"resultAutomationDecisions">[] = [];
  for (let offset = 0; offset < count; offset += 100) {
    ids.push(...await f.t.run(async (ctx) => {
      const tenant = (await ctx.db.get("tenants", f.tenantId))!;
      const decisions = [];
      for (let i = offset; i < Math.min(offset + 100, count); i++) {
        const leadId = options.reusePerson ? f.personId : await insertProviderPerson(ctx, f.tenantId);
        const inputKey = await sha256Hex(`case:${kind}:${leadId}:${i}:${options.wouldWrite}:${options.createdAt}`);
        decisions.push(await seedReadyDecision(ctx, {
          tenantId: f.tenantId, leadId, kind, inputKey, ruleVersion: currentRuleVersion(tenant, kind),
          policyVersion: tenant.resultAutomation!.kinds[kind]!.policyVersion,
          wouldWrite: options.wouldWrite ?? true, createdAt: options.createdAt ?? FIXTURE_NOW,
          providerPaymentId: f.providerPaymentId,
          evidence: { allocationRevision: 0, sourceUpdatedAt: FIXTURE_NOW,
            bindingIds: [f.productBindingId, f.variantBindingId], bindingVersions: [1, 1] },
          grade: options.grade ? {
            verdict: options.grade, gradedAt: FIXTURE_NOW, gradedByUserId: f.adminId, gradedBeforeSeeing: true, wrongFields: [],
          } : undefined,
        }));
      }
      return decisions;
    }));
  }
  return ids;
}

async function gradeMembers(f: Fixture, sampleId: Id<"automationSamples">, first: "correct" | "wrong" | "unsure" = "correct") {
  const rows = await f.t.run((ctx) => ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_sampleId_and_leadId", (q) => q.eq("tenantId", f.tenantId).eq("sampleId", sampleId))
    .take(301));
  const [head, ...rest] = rows;
  for (let offset = 0; offset < rest.length; offset += 100) {
    await f.t.run(async (ctx) => {
      for (const row of rest.slice(offset, offset + 100)) {
        await ctx.db.patch("resultAutomationDecisions", row._id, {
          grade: { verdict: "correct", gradedAt: FIXTURE_NOW, gradedByUserId: f.adminId, gradedBeforeSeeing: true, wrongFields: [] },
        });
      }
    });
  }
  await f.admin.mutation(grading.reveal, { decisionId: head._id });
  await f.admin.mutation(grading.commitAnswer, { decisionId: head._id, answer: { abstain: false } });
  await f.admin.mutation(grading.recordGrade, {
    decisionId: head._id, verdict: first, wrongFields: first === "wrong" ? ["person"] : [],
  });
  return head._id;
}

it("keeps correct abstentions separate, counts a person once, and excludes aged and already graded writes", async () => {
  const f = await fixture();
  await seed(f, 290, { wouldWrite: false, grade: "correct" });
  await seed(f, 10);
  await seed(f, 4, { reusePerson: true });
  await seed(f, 1, { createdAt: FIXTURE_NOW - CASE_MAX_AGE_MS - 1 });
  await seed(f, 1, { grade: "correct" });
  const sampleId = (await f.owner.mutation(certificates.openSample, { kind: "payment_win" }))!;
  await gradeMembers(f, sampleId);
  expect(await f.owner.query(certificates.getSampleProgress, { sampleId })).toMatchObject({
    members: 11, distinctPeople: 11, correct: 11, exposed: 1, target: 300, status: "collecting",
  });
  expect((await f.admin.query(grading.getGradeTally, { kind: "payment_win" })).abstentions.cleanBlind).toBe(290);
  expect(await f.owner.mutation(certificates.certify, { sampleId })).toEqual({ ok: false, code: "not_full" });
  expect(await f.owner.mutation(certificates.promoteKind, { kind: "payment_win", sampleId })).toEqual({
    ok: false, code: "certificate_required",
  });
  expect((await f.admin.query(grading.listToGrade, { kind: "payment_win", sample: "writes" })).cases
    .every((row) => row.createdAt >= FIXTURE_NOW - CASE_MAX_AGE_MS)).toBe(true);
  await assertAutomationInvariants(f.t, f);
});

it("keeps a system-loss Billing proposal out of payment certification and scheduling", async () => {
  const checkout = "ch_system_loss_fixture";
  const f = await paymentConfirmationFixture({
    dealPosition: "lost", lostReason: "no_show", fact: { checkoutConfigurationId: checkout },
  });
  await f.t.run((ctx) => insertProviderBinding(ctx, {
    ...f, externalId: checkout, binding: { kind: "checkout_deal", leadId: f.personId, opportunityId: f.dealId },
  }));
  const subject = {
    tenantId: f.tenantId, providerPaymentId: f.providerPaymentId, opportunityId: f.dealId, now: FIXTURE_NOW,
  };
  const evaluate = () => f.t.run((ctx) => evaluateSubject(ctx, { ...subject, cause: "provider_read" }));
  const ask = await evaluate();
  if (!ask.decisionId) throw new Error("Missing Billing proposal");
  const read = (id: Id<"resultAutomationDecisions">) => f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", id));
  expect(await read(ask.decisionId)).toMatchObject({ mode: "ask", wouldWrite: true, confirmRoute: "billing" });

  const ruleVersion = await f.t.run(async (ctx) => currentRuleVersion((await ctx.db.get("tenants", f.tenantId))!, "payment_win"));
  const sampleId = await seedAutomaticCertificate(f.t, {
    ...f, kind: "payment_win", promotedByUserId: f.ownerId, ruleVersion,
    scopeBindingIds: [f.productBindingId, f.variantBindingId],
  });
  const reevaluated = await evaluate();
  if (!reevaluated.decisionId) throw new Error("Missing proposal after promotion");
  const evaluatedRow = (await read(reevaluated.decisionId))!;
  const preview = await f.t.run((ctx) => previewProviderApply(ctx, subject));
  if (!preview.ok) throw new Error(preview.code);
  // Force a ready automatic row so the defensive writer sees the same inputs.
  await f.t.run((ctx) => ctx.db.patch("resultAutomationDecisions", evaluatedRow._id, { mode: "automatic" }));
  const applied = await f.t.run((ctx) => applyProviderPayment(ctx, {
    ...subject, decisionId: evaluatedRow._id, via: "automatic", certificateSampleId: sampleId,
    expectedFingerprint: preview.fingerprint, expectedAllocationRevision: preview.allocationRevision,
  }));
  expect(applied).toEqual({ ok: false, code: "needs_review" });
  expect(evaluatedRow).toMatchObject({ mode: "ask", wouldWrite: true, confirmRoute: "billing" });
  expect(evaluatedRow.dueAt).toBeUndefined();
  expect((await read(ask.decisionId))?.sampleId).toBeUndefined();
});

it("reports the fixed reason for an aged-out certificate sample", async () => {
  const f = await fixture();
  const [caseId] = await seed(f, 1);
  const sampleId = await f.t.run(async (ctx) => enrollInSample(ctx, (await ctx.db.get("resultAutomationDecisions", caseId))!));
  vi.setSystemTime(FIXTURE_NOW + CASE_MAX_AGE_MS + 1);
  const payment = (await f.owner.query(certificates.getCertificates, {})).find(({ kind }) => kind === "payment_win");
  expect(payment?.sample).toMatchObject({ sampleId, status: "lapsed", lapseReason: "aged_out" });
});

it("certifies 300 distinct people and lets only the owner put that kind at automatic", async () => {
  const f = await fixture();
  await seed(f, CERTIFICATE_TARGET.payment_win);
  const sampleId = (await f.owner.mutation(certificates.openSample, { kind: "payment_win" }))!;
  expect((await f.admin.query(grading.listToGrade, { kind: "payment_win", sample: "writes" })).cases).toHaveLength(50);
  const memberId = await gradeMembers(f, sampleId);
  await f.t.run((ctx) => ctx.db.patch("resultAutomationDecisions", memberId, { automaticEligible: false }));
  expect(await f.owner.mutation(certificates.certify, { sampleId })).toEqual({ ok: false, code: "not_full" });
  await f.t.run((ctx) => ctx.db.patch("resultAutomationDecisions", memberId, { automaticEligible: undefined }));
  const promote = { kind: "payment_win", sampleId } as const;
  await expect(f.admin.mutation(certificates.promoteKind, promote)).rejects.toThrow("Insufficient permissions");
  expect(await f.owner.mutation(certificates.promoteKind, promote)).toEqual({ ok: false, code: "certificate_required" });
  expect(await f.owner.mutation(certificates.certify, { sampleId })).toEqual({ ok: true });
  expect(await f.owner.mutation(certificates.promoteKind, { ...promote, kind: "additional_payment" }))
    .toEqual({ ok: false, code: "certificate_required" });
  expect((await f.owner.query(settings.getSettings, {})).automatic.payment_win.canPromote).toBe(true);
  expect((await f.admin.query(settings.getSettings, {})).automatic.payment_win.canPromote).toBe(false);
  expect(await f.owner.mutation(certificates.promoteKind, promote)).toEqual({ ok: true, alreadyApplied: false, sampleId });
  expect(await f.owner.mutation(certificates.promoteKind, promote)).toEqual({ ok: true, alreadyApplied: true, sampleId });
  expect((await f.owner.query(settings.getSettings, {})).effective.payment_win).toBe("automatic");
  await expect(f.owner.mutation(settings.setKindMode, {
    kind: "payment_win",
    // @ts-expect-error The server's argument validator must reject it, too.
    mode: "automatic",
  })).rejects.toThrow(/validator/i);
  await f.admin.mutation(certificates.demoteKind, { kind: "payment_win" });
  await f.admin.mutation(settings.setKindMode, { kind: "payment_win", mode: "shadow" });
  expect((await f.owner.query(settings.getSettings, {})).configured?.kinds.payment_win).toMatchObject({
    mode: "shadow", automatic: { sampleId, writes: 0 },
  });
  vi.setSystemTime(FIXTURE_NOW + CASE_MAX_AGE_MS + 1);
  expect(await f.owner.mutation(certificates.promoteKind, promote)).toEqual({ ok: false, code: "certificate_lapsed" });
  await assertAutomationInvariants(f.t, f);
});

it.each(["wrong", "unsure"] as const)("handles a %s verdict at the 60-person call-back bar", async (verdict) => {
  const f = await fixture("call_back");
  await seed(f, CERTIFICATE_TARGET.call_back, { kind: "call_back" });
  const sampleId = (await f.owner.mutation(certificates.openSample, { kind: "call_back" }))!;
  const decisionId = await gradeMembers(f, sampleId, verdict);
  expect(await f.owner.mutation(certificates.certify, { sampleId })).toEqual({ ok: false, code: verdict });
  expect(await f.owner.mutation(certificates.promoteKind, { sampleId, kind: "call_back" }))
    .toEqual({ ok: false, code: "certificate_required" });
  if (verdict === "wrong") {
    expect(await f.owner.mutation(certificates.openSample, { kind: "call_back" })).toBeNull();
  } else {
    await f.owner.mutation(grading.resolveUnsure, { decisionId, verdict: "correct" });
    expect(await f.owner.mutation(certificates.certify, { sampleId })).toEqual({ ok: true });
    expect(await f.owner.mutation(certificates.promoteKind, { sampleId, kind: "call_back" })).toMatchObject({ ok: true });
    const pending = await f.t.run(async (ctx) => {
      const tenant = (await ctx.db.get("tenants", f.tenantId))!;
      const id = await seedReadyDecision(ctx, {
        tenantId: f.tenantId, kind: "call_back", inputKey: await sha256Hex("automatic-call"),
        ruleVersion: currentRuleVersion(tenant, "call_back"), policyVersion: tenant.resultAutomation!.kinds.call_back!.policyVersion,
      });
      await ctx.db.patch("resultAutomationDecisions", id, { mode: "automatic", dueAt: FIXTURE_NOW });
      return (await ctx.db.get("resultAutomationDecisions", id))!;
    });
    const allowed = () => f.t.run((ctx) => assertAutomaticAllowed(ctx, {
      tenantId: f.tenantId, kind: "call_back", decision: pending,
    }));
    const readMode = () => f.t.run(async (ctx) => effectiveKindMode((await ctx.db.get("tenants", f.tenantId))!, "call_back"));
    expect(await readMode()).toBe("automatic");
    vi.setSystemTime(FIXTURE_NOW + CASE_MAX_AGE_MS + 1);
    expect(await readMode()).toBe("automatic");
    expect(await allowed()).toEqual({ ok: true, sampleId });
    await f.t.run(async (ctx) => {
      const tenant = (await ctx.db.get("tenants", f.tenantId))!;
      const callInsights = { ...tenant.callInsights!, model: "anthropic/claude-haiku-4.5" };
      await ctx.db.patch("tenants", f.tenantId, { callInsights });
    });
    expect(await readMode()).toBe("ask");
    expect(await allowed()).toMatchObject({ ok: false, code: "certificate_lapsed" });
    expect((await f.owner.query(settings.getSettings, {})).automatic.call_back).toMatchObject({
      certificateState: "lapsed", automaticBlockedReason: "certificate_lapsed",
    });
  }
  await assertAutomationInvariants(f.t, f);
});

it("enrolls new eligible decisions, lapses an old collecting cohort, and starts again", async () => {
  const f = await fixture();
  const enroll = (id: Id<"resultAutomationDecisions">) => f.t.run(async (ctx) =>
    enrollInSample(ctx, (await ctx.db.get("resultAutomationDecisions", id))!));
  const [id] = await seed(f, 1);
  const sampleId = (await enroll(id))!;
  expect(await enroll(id)).toBe(sampleId);
  vi.setSystemTime(FIXTURE_NOW + CASE_MAX_AGE_MS + 1);
  const [newId] = await seed(f, 1, { createdAt: Date.now() });
  const newSample = await enroll(newId);
  expect(newSample).not.toBe(sampleId);
  expect(await f.owner.query(certificates.getSampleProgress, { sampleId })).toMatchObject({ status: "lapsed" });
  await assertAutomationInvariants(f.t, f);
});

it("keeps mappings created after the sample opened outside its frozen scope", async () => {
  const f = await fixture();
  const sampleId = (await f.owner.mutation(certificates.openSample, { kind: "payment_win" }))!;
  const excluded = await f.t.run(async (ctx) => {
    const mapping = await insertProviderBinding(ctx, {
      ...f, externalId: "plan_new", binding: { kind: "variant_type", paymentType: "pif" },
    });
    const decisionId = await seedReadyDecision(ctx, {
      tenantId: f.tenantId, leadId: f.personId, evidence: {
        allocationRevision: 0, sourceUpdatedAt: FIXTURE_NOW,
        bindingIds: [f.productBindingId, mapping], bindingVersions: [1, 1],
      },
    });
    return enrollInSample(ctx, (await ctx.db.get("resultAutomationDecisions", decisionId))!);
  });
  expect(excluded).toBeNull();
  expect(await f.owner.query(certificates.getSampleProgress, { sampleId })).toMatchObject({ members: 0, scopeBindingIds: [] });
  await assertAutomationInvariants(f.t, f);
});
