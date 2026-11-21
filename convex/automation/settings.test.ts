import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import {
  automationFixtureApi, automationPaymentFixture, FIXTURE_NOW, seedReadyDecision, setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";
import { evaluateSubject } from "./decisions";

const { settings } = automationFixtureApi;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("automatic results settings", () => {
  it("returns Whop's last read from the connected environment", async () => {
    const f = await automationPaymentFixture();
    const settingsView = () => f.admin.query(settings.getSettings, {});
    expect(await settingsView()).toMatchObject({
      whopConnected: true, whopLastReadAt: FIXTURE_NOW - 1000, whopLagging: false,
    });
    const liveId = await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...sandbox } = (await ctx.db.get("tenantPaymentConnections", f.connectionId))!;
      return await ctx.db.insert("tenantPaymentConnections", {
        ...sandbox, environment: "live", lastSuccessfulSweepAt: undefined,
      });
    });
    expect(await settingsView()).toMatchObject({
      whopConnected: true, whopLastReadAt: null, whopLagging: true,
    });
    await f.t.run((ctx) => ctx.db.patch("tenantPaymentConnections", liveId, { status: "invalid_key" }));
    expect(await settingsView()).toMatchObject({
      whopConnected: true, whopLastReadAt: FIXTURE_NOW - 1000, whopLagging: true,
    });
    await f.t.run((ctx) => ctx.db.patch("tenantPaymentConnections", f.connectionId, { status: "disconnected" }));
    expect(await settingsView()).toMatchObject({
      whopConnected: false, whopLastReadAt: null, whopLagging: true,
    });
  });

  it("defaults off, authorizes owner raises, and leaves manual-write inputs unchanged", async () => {
    const f = await automationPaymentFixture();
    // An admin can lower and cannot raise; nothing is configured, every kind
    // reads off, and no kind has a certificate or can be promoted.
    const initial = await f.admin.query(settings.getSettings, {});
    expect(initial).toMatchObject({
      configured: null, effective: { payment_win: "off", additional_payment: "off" },
      canRaise: false, canLower: true,
    });
    for (const state of Object.values(initial.automatic)) {
      expect(state).toEqual({
        automaticBlockedReason: null, breaker: null, canPromote: false, certificateState: "none", sampleId: null,
      });
    }
    await expect(f.closer.query(settings.getSettings, {})).rejects.toThrow("Insufficient permissions");
    await expect(f.admin.mutation(settings.setEnabled, { enabled: true })).rejects.toThrow("Insufficient permissions");
    await expect(f.admin.mutation(settings.setKindMode, { kind: "payment_win", mode: "shadow" })).rejects.toThrow("Insufficient permissions");

    const snapshot = () => f.t.run(async (ctx) => ({
      deal: await ctx.db.get("opportunities", f.dealId!),
      person: await ctx.db.get("leads", f.personId),
      payment: await ctx.db.get("providerPayments", f.providerPaymentId),
      records: await ctx.db.query("paymentRecords").take(10),
      meetings: await ctx.db.query("meetings").take(10),
      tasks: await ctx.db.query("followUps").take(10),
    }));
    const before = await snapshot();
    await f.owner.mutation(settings.setKindMode, { kind: "payment_win", mode: "shadow" });
    expect((await f.owner.query(settings.getSettings, {})).effective.payment_win).toBe("off");
    await f.owner.mutation(settings.setEnabled, { enabled: true });
    expect((await f.owner.query(settings.getSettings, {})).effective.payment_win).toBe("shadow");
    const evaluate = () => f.t.run((ctx) => evaluateSubject(ctx, { ...f, cause: "settings", now: FIXTURE_NOW }));
    const shadow = await evaluate();
    expect(await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", shadow.decisionId!))).toMatchObject({ state: "shadow" });
    await f.owner.mutation(settings.setKindMode, { kind: "payment_win", mode: "ask" });
    const ask = await evaluate();
    expect(await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", ask.decisionId!))).toMatchObject({ state: "ready" });
    const args = { kind: "payment_win", mode: "ask" } as const;
    const policy = (await f.owner.query(settings.getSettings, {})).configured;
    await f.owner.mutation(settings.setKindMode, args);
    expect((await f.owner.query(settings.getSettings, {})).configured).toEqual(policy);
    expect(policy?.kinds).toMatchObject({
      payment_win: { policyVersion: 2 }, additional_payment: { policyVersion: 0 },
    });
    expect(await snapshot()).toEqual(before);
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("lets admins lower one kind and pause both, without resuming old proposals on enable", async () => {
    const f = await automationPaymentFixture();
    const [win, additional] = await f.t.run(async (ctx) => {
      await setPaymentFixtureModes(ctx, f);
      return [
        await seedReadyDecision(ctx, { tenantId: f.tenantId, providerPaymentId: f.providerPaymentId, opportunityId: f.dealId }),
        await seedReadyDecision(ctx, { tenantId: f.tenantId, kind: "additional_payment", opportunityId: f.dealId }),
      ];
    });
    const rows = () => f.t.run(async (ctx) => Promise.all([
      ctx.db.get("resultAutomationDecisions", win), ctx.db.get("resultAutomationDecisions", additional),
    ]));
    await f.admin.mutation(settings.setKindMode, { kind: "payment_win", mode: "shadow" });
    expect(await rows()).toMatchObject([{ state: "stopped", stopCode: "kind_lowered" }, { state: "ready" }]);
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });

    await f.admin.mutation(settings.setEnabled, { enabled: false });
    expect(await rows()).toMatchObject([{ state: "stopped", stopCode: "kind_lowered" }, { state: "stopped", stopCode: "paused" }]);
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    const evaluate = () => f.t.run((ctx) => evaluateSubject(ctx, { ...f, cause: "sweep", now: FIXTURE_NOW }));
    expect(await evaluate()).toEqual({ decisionId: null });
    const paused = await rows();
    await f.owner.mutation(settings.setEnabled, { enabled: true });
    expect(await rows()).toEqual(paused);
    await f.owner.mutation(settings.setKindMode, { kind: "payment_win", mode: "ask" });
    const { decisionId } = await evaluate();
    expect(await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", decisionId!))).toMatchObject({
      state: "needs_person", gates: ["stood_down"], activationVersion: 3,
    });
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("keeps an older payment with Billing when its first evaluation arrives after a pause", async () => {
    const f = await automationPaymentFixture();
    await f.t.run((ctx) => setPaymentFixtureModes(ctx, f));
    await f.admin.mutation(settings.setEnabled, { enabled: false });
    await f.owner.mutation(settings.setEnabled, { enabled: true });

    const { decisionId } = await f.t.run((ctx) => evaluateSubject(ctx, { ...f, cause: "sweep", now: FIXTURE_NOW }));
    expect(await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", decisionId!))).toMatchObject({
      state: "needs_person", gates: ["stood_down"],
    });
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("lets only the owner assign an eligible tenant grader and emits actor and settings metadata", async () => {
    const f = await automationPaymentFixture();
    await expect(f.admin.mutation(settings.setGrader, { userId: f.adminId })).rejects.toThrow("Insufficient permissions");
    await expect(f.owner.mutation(settings.setGrader, { userId: f.closerId })).rejects.toThrow("Choose an active owner or admin");
    await f.owner.mutation(settings.setGrader, { userId: f.adminId });
    expect((await f.owner.query(settings.getSettings, {})).configured?.graderUserId).toBe(f.adminId);
    const rows = await f.t.run((ctx) => ctx.db.query("domainEvents").withIndex("by_tenantId_and_eventType_and_occurredAt", (q) =>
      q.eq("tenantId", f.tenantId).eq("eventType", "automation.settings_changed")).take(2));
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(f.ownerId);
    expect(JSON.parse(rows[0].metadata!)).toEqual({ kind: "grader", graderUserId: f.adminId, activationVersion: 0 });
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });
});

it("reports the Call insights switch even with no call automation configured", async () => {
  const f = await automationPaymentFixture();
  const load = () => f.admin.query(automationFixtureApi.settings.getSettings, {});
  expect(await load()).toMatchObject({ callInsightsOn: false });
  await f.t.run(async (ctx) => {
    const { initialSettings } = await import("../callInsights/settings");
    await ctx.db.patch("tenants", f.tenantId, { callInsights: initialSettings(f.ownerId, FIXTURE_NOW) });
  });
  expect(await load()).toMatchObject({ callInsightsOn: true });
});

const source = (path: string) => readFileSync(path, "utf8");
const integrations = "app/workspace/settings/_components/integrations/integrations-tab.tsx";
const gradingCase = "app/workspace/settings/automatic-results/_components/grading-case.tsx";

it("blocks replay capture on the grading payer email", () => {
  expect(source(gradingCase)).toMatch(/<span[^>]*className="[^"]*ph-no-capture[^"]*"[^>]*>\{evidence\.payerEmail\}<\/span>/);
});

it("links directly to Automatic results from Settings only for authorized roles", () => {
  expect(source(integrations)).toMatch(
    /hasPermission\("result-automation:view"\)[\s\S]*?<Link href="\/workspace\/settings\/automatic-results">Automatic results\s*<ChevronRightIcon/,
  );
});

it("keeps the Fathom priority read below a boundary with a quiet Whop fallback", () => {
  const code = source(integrations);
  expect(code.slice(0, code.indexOf("function WhopWithFathomStatus"))).not.toContain("useQuery(api.fathom.connection.settings");
  expect(code).toMatch(/<SectionErrorBoundary[^>]*fallback=\{<WhopIntegrationCard quiet \/>\}>[\s\S]*?<WhopWithFathomStatus/);
  expect(code).toMatch(/function WhopWithFathomStatus[\s\S]*?useQuery\(api\.fathom\.connection\.settings/);
});
