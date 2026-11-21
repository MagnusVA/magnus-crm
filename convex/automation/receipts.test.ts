import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_NOW, FIXTURE_PAID_AT, providerPaymentFixture, seedReadyDecision } from "../../tests/providerPaymentFixtures";
import { assertPaymentInvariants, seedProviderWin } from "../../tests/paymentInvariants";
import { noteHumanResult } from "./humanResult";
import { PERSON_PICK_RULE_VERSION, paymentVetoKey, recordApplyReceipt, type PaymentDecisionKind } from "./receipts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const BEFORE = {
  position: "booked" as const,
  latestActivityAt: FIXTURE_PAID_AT - 1000,
  meetings: [],
  tasks: [],
};

async function confirmedWin(options: { ready: boolean }) {
  const h = await providerPaymentFixture({ dealPosition: "booked" });
  const dealId = h.dealId!;
  const decisionId = options.ready
    ? await h.t.run((ctx) => seedReadyDecision(ctx, {
      tenantId: h.tenantId, providerPaymentId: h.providerPaymentId, opportunityId: dealId, leadId: h.personId,
    }))
    : undefined;
  const paymentRecordId = await h.t.run((ctx) => seedProviderWin(ctx, {
    tenantId: h.tenantId, opportunityId: dealId, providerPaymentId: h.providerPaymentId, programId: h.programId,
    closerId: h.closerId, approverId: h.adminId, recordedAt: FIXTURE_NOW,
  }));
  const args = {
    decisionId, tenantId: h.tenantId, kind: "payment_win" as PaymentDecisionKind, providerPaymentId: h.providerPaymentId,
    opportunityId: dealId, paymentRecordId, appliedVia: "billing" as const, approverUserId: h.adminId,
    before: BEFORE, now: FIXTURE_NOW,
  };
  const record = (overrides: Partial<typeof args> = {}) =>
    h.t.run((ctx) => recordApplyReceipt(ctx, { ...args, ...overrides }));
  return { ...h, dealId, decisionId, paymentRecordId, args, record };
}

const decisionsFor = (h: Awaited<ReturnType<typeof confirmedWin>>) => h.t.run(async (ctx) =>
  await ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_providerPaymentId_and_state", (q) =>
      q.eq("tenantId", h.tenantId).eq("providerPaymentId", h.providerPaymentId))
    .take(20));

describe("recordApplyReceipt", () => {
  it("marks the ready decision applied with what the confirmation changed", async () => {
    const h = await confirmedWin({ ready: true });
    expect(await h.record()).toBe(h.decisionId);
    const [row] = await decisionsFor(h);
    expect(row).toMatchObject({
      _id: h.decisionId, state: "applied", resolvedAt: FIXTURE_NOW, resolvedByUserId: h.adminId,
      appliedPaymentRecordId: h.paymentRecordId, appliedVia: "billing", before: BEFORE,
    });
    await assertPaymentInvariants(h.t, { tenantId: h.tenantId });
  });

  it("returns the same receipt on a retry and writes nothing", async () => {
    const h = await confirmedWin({ ready: true });
    await h.record();
    const before = await decisionsFor(h);
    vi.setSystemTime(FIXTURE_NOW + 60_000);
    expect(await h.record({ now: FIXTURE_NOW + 60_000 })).toBe(h.decisionId);
    expect(await decisionsFor(h)).toEqual(before);
  });

  it("inserts an applied ask decision when a person picked the deal with none ready", async () => {
    const h = await confirmedWin({ ready: false });
    const receiptId = await h.record();
    const rows = await decisionsFor(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      _id: receiptId, kind: "payment_win", mode: "ask", state: "applied", ruleVersion: PERSON_PICK_RULE_VERSION,
      vetoKey: await paymentVetoKey(h.providerPaymentId, h.dealId), humanResultRevision: 0, wouldWrite: false, gates: [],
      providerPaymentId: h.providerPaymentId, leadId: h.personId, opportunityId: h.dealId, assignedCloserId: h.closerId,
      evidence: { allocationRevision: 1, bindingIds: [], bindingVersions: [] },
      appliedPaymentRecordId: h.paymentRecordId, appliedVia: "billing", before: BEFORE,
      resolvedAt: FIXTURE_NOW, resolvedByUserId: h.adminId, policyVersion: 0, activationVersion: 0,
    });
    expect(rows[0].inputKey).toMatch(/^[0-9a-f]{64}$/);
    expect(await h.record()).toBe(receiptId);
    expect(await decisionsFor(h)).toHaveLength(1);
    await assertPaymentInvariants(h.t, { tenantId: h.tenantId });
  });

  it("with noteHumanResult consuming it, records the revision undo compares against", async () => {
    const h = await confirmedWin({ ready: true });
    const receiptId = await h.record();
    const { revision } = await h.t.run((ctx) => noteHumanResult(ctx, h.dealId, {
      tenantId: h.tenantId, userId: h.adminId,
    }, { consumeDecisionId: receiptId }));
    const [row] = await decisionsFor(h);
    expect(row).toMatchObject({ state: "applied", humanResultRevision: 0, humanResultRevisionAfter: revision });
    expect(await h.t.run((ctx) => ctx.db.get("opportunities", h.dealId))).toMatchObject({ humanResultRevision: revision });
    await assertPaymentInvariants(h.t, { tenantId: h.tenantId });
  });

  it.each([
    ["a stopped decision", "stopped", "is stopped, not ready"],
    ["a decision applied to another row", "applied", "was applied to another payment"],
  ] as const)("refuses %s", async (_label, state, message) => {
    const h = await confirmedWin({ ready: true });
    await h.t.run(async (ctx) => {
      const otherRow = await ctx.db.insert("paymentRecords", {
        tenantId: h.tenantId, opportunityId: h.dealId, attributedCloserId: h.closerId, amountMinor: 100, currency: "USD",
        recordedByUserId: h.adminId, programId: h.programId, programName: "Sales training", paymentType: "split",
        status: "disputed", recordedAt: FIXTURE_PAID_AT, origin: "admin_additional",
      });
      await ctx.db.patch("resultAutomationDecisions", h.decisionId!, {
        state, appliedPaymentRecordId: state === "applied" ? otherRow : undefined,
      });
    });
    await expect(h.record()).rejects.toThrow(message);
  });

  it("refuses a decision about another deal or kind", async () => {
    const h = await confirmedWin({ ready: true });
    await expect(h.record({ kind: "additional_payment" })).rejects.toThrow("is not this payment's additional_payment");
  });

  it("refuses a row the payment doesn't count through", async () => {
    const h = await confirmedWin({ ready: true });
    await h.t.run(async (ctx) => {
      await ctx.db.patch("providerPayments", h.providerPaymentId, { paymentRecordId: undefined, reviewState: "needs_person" });
    });
    await expect(h.record()).rejects.toThrow("doesn't count through");
  });
});
