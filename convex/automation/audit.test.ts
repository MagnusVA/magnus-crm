import { anyApi, makeFunctionReference, type ApiFromModules } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertAutomationInvariants } from "../../tests/automationInvariants";
import {
  automationFixtureApi, automationPaymentFixture, FIXTURE_NOW, insertProviderPerson, seedAppliedReceipt,
  seedAutomationSample, seedReadyDecision, setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";
import type { Doc } from "../_generated/dataModel";
import { initialSettings as initialCallSettings } from "../callInsights/settings";
import { sha256Hex } from "../lib/stableHash";
import { auditReasonFor, scheduleAudit } from "./audit";
import { oneBusinessDayAfter } from "./breaker";
import { currentRuleVersion } from "./settings";

const auditApi = (anyApi as unknown as ApiFromModules<{
  "automation/audit": typeof import("./audit"); "automation/breaker": typeof import("./breaker");
}>).automation;
const sweepDeadlines = makeFunctionReference<"mutation", { cursor: null; through: number }>(
  "automation/sweep:auditDeadlinePage",
);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function fixture({ writes = 0 } = {}) {
  const f = await automationPaymentFixture();
  const sample = await f.t.run(async (ctx) => {
    await setPaymentFixtureModes(ctx, f);
    const base = (await ctx.db.get("tenants", f.tenantId))!;
    const settings = base.resultAutomation!;
    const callInsights = initialCallSettings(f.ownerId, FIXTURE_NOW);
    const ruleVersion = currentRuleVersion({ ...base, callInsights }, "call_back");
    const sampleId = await seedAutomationSample(ctx, {
      tenantId: f.tenantId, kind: "call_back", target: 60, status: "certified",
      ruleVersion, firstCaseAt: FIXTURE_NOW, fullAt: FIXTURE_NOW, certifiedAt: FIXTURE_NOW,
    });
    for (let i = 0; i < 60; i++) {
      const leadId = await insertProviderPerson(ctx, f.tenantId);
      await seedReadyDecision(ctx, {
        tenantId: f.tenantId, kind: "call_back", leadId, ruleVersion, sampleId,
        inputKey: await sha256Hex(`member:${i}`),
        grade: { verdict: "correct", gradedAt: FIXTURE_NOW, gradedByUserId: f.ownerId, gradedBeforeSeeing: true, wrongFields: [] },
      });
    }
    await ctx.db.patch("tenants", f.tenantId, {
      callInsights,
      resultAutomation: { ...settings, kinds: { ...settings.kinds, call_back: {
        mode: "automatic", policyVersion: 2, changedAt: FIXTURE_NOW, changedByUserId: f.ownerId,
        automatic: { sampleId, ruleVersion, promotedAt: FIXTURE_NOW, promotedByUserId: f.ownerId, writes },
      } } },
    });
    return { sampleId, ruleVersion };
  });
  return { ...f, ...sample };
}

async function recordWrites(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  return f.t.run(async (ctx) => {
    const receipts: Doc<"resultAutomationDecisions">[] = [];
    for (let i = 0; i < count; i++) {
      const id = await seedAppliedReceipt(ctx, {
        tenantId: f.tenantId, kind: "call_back", ruleVersion: f.ruleVersion, policyVersion: 2,
        certificateSampleId: f.sampleId, appliedVia: "automatic", inputKey: await sha256Hex(`write:${i}`),
      });
      await ctx.db.patch("resultAutomationDecisions", id, { mode: "automatic" });
      const row = (await ctx.db.get("resultAutomationDecisions", id))!;
      await scheduleAudit(ctx, row, FIXTURE_NOW);
      await scheduleAudit(ctx, row, FIXTURE_NOW); // Retrying cannot count a second write.
      receipts.push((await ctx.db.get("resultAutomationDecisions", id))!);
    }
    return receipts;
  });
}

it("audits the first ten, then selects a stable fifth by decision ID and reports the queue and writes", async () => {
  const f = await fixture();
  const receipts = await recordWrites(f, 35);
  const expected = await Promise.all(receipts.map(async (row, i) => {
    const hash = await sha256Hex(row._id);
    return i < 10 ? "canary" : Number.parseInt(hash.slice(0, 8), 16) % 5 === 0 ? "sampled" : null;
  }));
  expect(expected.slice(10)).toContain("sampled");
  expect(expected.slice(10)).toContain(null);
  expect(receipts.map(({ auditReason }) => auditReason ?? null)).toEqual(expected);
  expect(auditReasonFor(10, "00000005")).toBe("sampled");
  expect(auditReasonFor(10, "00000006")).toBeNull();
  const queue = await f.admin.query(auditApi.audit.listAuditQueue, { kind: "call_back" });
  expect(queue.cases).toHaveLength(expected.filter(Boolean).length);
  expect(queue.cases[0]).toMatchObject({ reason: "canary", dueAt: FIXTURE_NOW + 86_400_000 });
  expect(queue.cases.at(-1)).toMatchObject({ reason: "sampled", dueAt: FIXTURE_NOW + 7 * 86_400_000 });
  await expect(f.closer.query(auditApi.audit.listAuditQueue, {})).rejects.toThrow("Insufficient permissions");
  const scorecard = await f.admin.query(automationFixtureApi.scorecard.getAutomationScorecard, { windowDays: 7 });
  expect(scorecard.automaticWrites.call_back).toEqual({ count: 35, capped: false });
  expect(scorecard.auditQueue).toEqual({ count: queue.cases.length, oldestAt: FIXTURE_NOW, capped: false });
  expect((await f.owner.query(automationFixtureApi.settings.getSettings, {})).configured?.kinds.call_back?.automatic?.writes)
    .toBe(35);
  await assertAutomationInvariants(f.t, f);
});

it.each(["canary", "sampled"] as const)("trips at the %s deadline in the bounded sweep", async (reason) => {
  const f = await fixture({ writes: reason === "canary" ? 0 : 10 });
  const rows = await recordWrites(f, reason === "canary" ? 1 : 35);
  const due = rows.find((row) => row.auditReason === reason)!;
  const tenant = (await f.t.run((ctx) => ctx.db.get("tenants", f.tenantId)))!;
  expect(due.auditOpenDueAt).toBe(reason === "canary" ? oneBusinessDayAfter(tenant, FIXTURE_NOW) : FIXTURE_NOW + 7 * 86_400_000);
  vi.setSystemTime(due.auditOpenDueAt! - 1);
  await f.t.mutation(sweepDeadlines, { cursor: null, through: Date.now() });
  expect((await f.owner.query(automationFixtureApi.settings.getSettings, {})).breakers).toEqual([]);
  vi.setSystemTime(due.auditOpenDueAt!);
  await f.t.mutation(sweepDeadlines, { cursor: null, through: Date.now() });
  const view = await f.owner.query(automationFixtureApi.settings.getSettings, {});
  expect(view.breakers).toMatchObject([{ kind: "call_back", reason: "audit_overdue", decisionId: due._id }]);
  expect(view.callEffective?.call_back).toBe("ask");
  expect(await f.owner.mutation(auditApi.breaker.resetBreaker, { kind: "call_back" }))
    .toEqual({ ok: false, code: "needs_review" });
  await assertAutomationInvariants(f.t, f);
});
