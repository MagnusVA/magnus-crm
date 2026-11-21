import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertAutomationInvariants } from "../../tests/automationInvariants";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import { storeProofFile } from "../../tests/proofFixtures";
import {
  FIXTURE_NOW, insertProviderDeal, insertProviderFact, insertProviderMeeting, insertProviderPerson,
  paymentConfirmationApi, paymentConfirmationFixture, seedAutomaticCertificate,
} from "../../tests/providerPaymentFixtures";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { billingPaymentsByStatus } from "../billing/aggregates";
import { transitionOpportunity } from "../lib/opportunityActivity";
import { insertAutomaticPayment, insertRecordedPayment } from "../lib/paymentWrite";
import { applyProviderPayment } from "../payments/apply";
import { opportunityByStage, paymentSums } from "../reporting/aggregates";
import { AUTOMATIC_WIN_GRACE_MS, WHOP_STALE_RETRY_MS } from "./automaticPayments";
import { CANARY_COUNT } from "./audit";
import { evaluateSubject } from "./decisions";
import { deriveDecision, PAYMENT_RULE_VERSION, type PaymentDecisionInput } from "./derive";

const confirm = paymentConfirmationApi.payments.confirm;
const execute = internal.automation.automaticPayments.executeAutomaticPayment;
const HOUR = 3_600_000;
const GRACE = AUTOMATIC_WIN_GRACE_MS;
type Fixture = Awaited<ReturnType<typeof paymentConfirmationFixture>>;
type DecisionId = Id<"resultAutomationDecisions">;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function invariants(f: Fixture) {
  await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  await assertAutomationInvariants(f.t, { tenantId: f.tenantId });
}

/** The payment fixture with the win kind promoted to automatic and a call on the deal. */
async function automaticFixture(meetingAt: number = FIXTURE_NOW + 2 * HOUR) {
  const f = await paymentConfirmationFixture();
  const sampleId = await seedAutomaticCertificate(f.t, {
    tenantId: f.tenantId, promotedByUserId: f.ownerId, kind: "payment_win", ruleVersion: PAYMENT_RULE_VERSION,
    scopeBindingIds: [f.productBindingId, f.variantBindingId],
  });
  const meetingId = await f.t.run((ctx) => insertProviderMeeting(ctx, {
    tenantId: f.tenantId, opportunityId: f.dealId, closerId: f.closerId, scheduledAt: meetingAt,
  }));
  return { ...f, sampleId, meetingId };
}

async function evaluate(f: Fixture, providerPaymentId = f.providerPaymentId): Promise<DecisionId> {
  const { decisionId } = await f.t.run((ctx) => evaluateSubject(ctx, {
    tenantId: f.tenantId, providerPaymentId, cause: "provider_read", now: Date.now(),
  }));
  if (!decisionId) throw new Error("No decision");
  return decisionId;
}

const decisionOf = (f: Fixture, id: DecisionId) => f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", id));
const dealRows = (f: Fixture, opportunityId = f.dealId) => f.t.run((ctx) => ctx.db.query("paymentRecords")
  .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", opportunityId)).take(50));

async function pin(f: Fixture) {
  const selection = { providerPaymentId: f.providerPaymentId, opportunityId: f.dealId };
  const { preview, decisionId } = await f.admin.query(confirm.previewWhopConfirm, selection);
  if (!preview.ok) throw new Error(preview.code);
  return {
    ...selection, decisionId, expectedFingerprint: preview.fingerprint, expectedAllocationRevision: preview.allocationRevision,
  };
}

/** What a win leaves behind, without ids that differ between two fixtures. */
async function winSnapshot(f: Fixture, paymentId: Id<"paymentRecords">, meetingId: Id<"meetings">) {
  return await f.t.run(async (ctx) => {
    const deal = (await ctx.db.get("opportunities", f.dealId))!;
    const meeting = (await ctx.db.get("meetings", meetingId))!;
    const payment = (await ctx.db.get("paymentRecords", paymentId))!;
    const providerPayment = (await ctx.db.get("providerPayments", f.providerPaymentId))!;
    const events = await ctx.db.query("domainEvents").take(40);
    const enrollments = await ctx.db.query("enrollments").take(5);
    const lines = await ctx.db.query("closerPinnedLines").take(5);
    const namespace = f.tenantId;
    return {
      deal: {
        stage: deal.stage, outcome: deal.outcome, paymentReceivedAt: deal.paymentReceivedAt,
        soldProgram: [deal.soldProgramId === f.programId, deal.soldProgramName], updatedAt: deal.updatedAt,
        latestActivityAt: deal.latestActivityAt,
      },
      meeting: { status: meeting.status, attendanceOwedSince: meeting.attendanceOwedSince, heldMarkedAt: meeting.heldMarkedAt },
      payment: {
        amountMinor: payment.amountMinor, currency: payment.currency, paymentType: payment.paymentType,
        program: [payment.programId === f.programId, payment.programName], status: payment.status,
        recordedAt: payment.recordedAt, statusChangedAt: payment.statusChangedAt, origin: payment.origin,
        recordedVia: payment.recordedVia, credit: payment.attributedCloserId === f.closerId,
        providerPaidAt: payment.providerPaidAt, meetingId: payment.meetingId, proofFileId: payment.proofFileId,
      },
      providerPayment: {
        reviewState: providerPayment.reviewState, allocationRevision: providerPayment.allocationRevision,
        points: providerPayment.paymentRecordId === paymentId, matchMethod: providerPayment.matchMethod,
      },
      enrollments: enrollments.map(({ enrolledAt, status, programId }) => ({ enrolledAt, status, program: programId === f.programId })),
      lines: lines.map(({ kind, amountMinor, currency, userId }) => ({ kind, amountMinor, currency, closer: userId === f.closerId })),
      aggregates: [
        await paymentSums.count(ctx, { namespace }), await paymentSums.sum(ctx, { namespace }),
        await billingPaymentsByStatus.count(ctx, { namespace }), await billingPaymentsByStatus.sum(ctx, { namespace }),
        await opportunityByStage.count(ctx, { namespace, bounds: { prefix: ["closed", "won", f.closerId] } }),
      ],
      events: events.map(({ eventType, occurredAt, fromStatus, toStatus, metadata }) => {
        const fields = JSON.parse(metadata ?? "{}");
        for (const id of ["paymentId", "meetingId", "providerPaymentId", "decisionId", "recordedByUserId", "opportunityId",
          "programId", "attributedCloserId", "enrollmentId", "leadId"]) delete fields[id];
        return { eventType, occurredAt, fromStatus, toStatus, fields };
      }),
      actors: events.map(({ source, actorUserId }) => ({ source, actorUserId })),
    };
  });
}

describe("executeAutomaticPayment", () => {
  it("writes a win that equals a Billing confirmation of the same payment, minus the recorder", async () => {
    // A person picks the payment in Billing at the time the automatic write would run.
    const billing = await paymentConfirmationFixture();
    const billingMeeting = await billing.t.run((ctx) => insertProviderMeeting(ctx, {
      tenantId: billing.tenantId, opportunityId: billing.dealId, closerId: billing.closerId, scheduledAt: FIXTURE_NOW + 2 * HOUR,
    }));
    vi.setSystemTime(FIXTURE_NOW + GRACE);
    const confirmed = await billing.admin.mutation(confirm.confirmWhopPayment, await pin(billing));
    if (!confirmed.ok) throw new Error(confirmed.code);
    await invariants(billing);
    const fromBilling = await winSnapshot(billing, confirmed.paymentRecordId, billingMeeting);

    vi.setSystemTime(FIXTURE_NOW);
    const f = await automaticFixture();
    const decisionId = await evaluate(f);
    expect(await decisionOf(f, decisionId)).toMatchObject({
      state: "ready", mode: "automatic", confirmRoute: "billing", dueAt: FIXTURE_NOW + GRACE,
    });
    await invariants(f);
    vi.setSystemTime(FIXTURE_NOW + GRACE - 1);
    expect(await f.t.mutation(execute, { decisionId })).toBe("not_due");
    expect(await dealRows(f)).toEqual([]);
    vi.setSystemTime(FIXTURE_NOW + GRACE);
    expect(await f.t.mutation(execute, { decisionId })).toBe("applied");
    await invariants(f);

    const [row] = await dealRows(f);
    expect(row.recordedByUserId).toBeUndefined();
    expect(row).toMatchObject({ origin: "provider", recordedVia: "provider", automationDecisionId: decisionId });
    const automatic = await winSnapshot(f, row._id, f.meetingId);
    expect(automatic).toEqual({ ...fromBilling, actors: automatic.actors });
    expect(automatic.actors.every(({ source, actorUserId }) => source === "system" && actorUserId === undefined)).toBe(true);
    // Where the confirmation names its approver, the automatic write names nobody.
    expect(fromBilling.actors.filter(({ actorUserId }) => actorUserId === billing.adminId).length).toBeGreaterThan(2);

    const [receipt, deal, tenant] = await f.t.run(async (ctx) => [
      await ctx.db.get("resultAutomationDecisions", decisionId),
      await ctx.db.get("opportunities", f.dealId),
      await ctx.db.get("tenants", f.tenantId),
    ] as const);
    expect(receipt).toMatchObject({
      state: "applied", mode: "automatic", appliedVia: "automatic", appliedPaymentRecordId: row._id,
      certificateSampleId: f.sampleId, humanResultRevisionAfter: 0, auditReason: "canary",
      before: { position: "booked" },
    });
    expect(receipt?.resolvedByUserId).toBeUndefined();
    expect(receipt?.auditOpenDueAt).toBeGreaterThan(FIXTURE_NOW + GRACE);
    // No person acted: the deal's revision is the one the decision read.
    expect(deal?.humanResultRevision ?? 0).toBe(0);
    expect(tenant?.resultAutomation?.kinds.payment_win.automatic?.writes).toBe(1);
    expect(await f.t.run((ctx) => ctx.db.query("secondOpinions").take(1))).toEqual([]);
  });

  it("allows a row with no recorder only through the automatic entry point and an automatic apply", async () => {
    const f = await automaticFixture();
    const decisionId = await evaluate(f);
    const row = {
      tenantId: f.tenantId, opportunityId: f.dealId, attributedCloserId: f.closerId, amountMinor: 10000, currency: "USD",
      paymentType: "pif", programId: f.programId, programName: "Sales training", recordedAt: FIXTURE_NOW,
      origin: "provider", recordedVia: "provider", providerPaymentId: f.providerPaymentId,
    } as const;
    await expect(f.t.run((ctx) => insertRecordedPayment(ctx, { ...row, recordedByUserId: undefined as never })))
      .rejects.toThrow("needs its recorder");
    await expect(f.t.run((ctx) => insertAutomaticPayment(ctx, { ...row, origin: "admin_meeting" as never, automationDecisionId: decisionId })))
      .rejects.toThrow("automatic decision wrote");
    await expect(f.t.run((ctx) => insertAutomaticPayment(ctx, { ...row, recordedByUserId: f.adminId, automationDecisionId: decisionId } as never)))
      .rejects.toThrow("automatic decision wrote");
    await f.t.run((ctx) => ctx.db.patch("resultAutomationDecisions", decisionId, { mode: "ask" }));
    await expect(f.t.run((ctx) => insertAutomaticPayment(ctx, { ...row, automationDecisionId: decisionId })))
      .rejects.toThrow("not a ready automatic decision");
    const apply = { tenantId: f.tenantId, providerPaymentId: f.providerPaymentId, opportunityId: f.dealId, now: FIXTURE_NOW,
      expectedFingerprint: "x", expectedAllocationRevision: 0 };
    await expect(f.t.run((ctx) => applyProviderPayment(ctx, { ...apply, via: "billing" })))
      .rejects.toThrow("no approver");
    await expect(f.t.run((ctx) => applyProviderPayment(ctx, {
      ...apply, via: "automatic", decisionId, certificateSampleId: f.sampleId,
      approver: { userId: f.adminId, role: "tenant_admin", source: "admin" },
    }))).rejects.toThrow("no approver");
    expect(await dealRows(f)).toEqual([]);
    await invariants(f);
  });

  it("lets the closer's own save inside the grace win, keeping proof and attendance", async () => {
    const f = await automaticFixture(FIXTURE_NOW - 30 * 60_000);
    const decisionId = await evaluate(f);
    expect(await decisionOf(f, decisionId)).toMatchObject({ mode: "automatic", confirmRoute: "meeting", dueAt: FIXTURE_NOW + GRACE });

    vi.setSystemTime(FIXTURE_NOW + 5 * 60_000);
    const proofFileId = await storeProofFile(f.t);
    const paymentId = await f.closer.mutation(api.closer.payments.logPayment, {
      opportunityId: f.dealId, meetingId: f.meetingId, programId: f.programId, amount: 100, currency: "USD",
      paymentType: "pif", proofFileId,
      provider: { kind: "confirm", providerPaymentId: f.providerPaymentId, expectedAllocationRevision: 0 },
    });
    await invariants(f);

    vi.setSystemTime(FIXTURE_NOW + GRACE);
    expect(await f.t.mutation(execute, { decisionId })).toBe("not_due");
    const rows = await dealRows(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ _id: paymentId, recordedByUserId: f.closerId, proofFileId, origin: "provider" });
    const [decision, meeting] = await f.t.run(async (ctx) => [
      await ctx.db.get("resultAutomationDecisions", decisionId), await ctx.db.get("meetings", f.meetingId),
    ] as const);
    // The closer's save stood the automatic decision down; it never applied.
    expect(["stopped", "superseded"]).toContain(decision?.state);
    expect(decision?.appliedVia).toBeUndefined();
    expect(meeting).toMatchObject({ status: "held", heldMarkedAt: FIXTURE_NOW + 5 * 60_000 });
    await invariants(f);
  });

  it("wakes at the grace's end, writes once however often it wakes, and audits the write", async () => {
    const f = await automaticFixture();
    const decisionId = await evaluate(f);
    await vi.advanceTimersByTimeAsync(GRACE);
    await f.t.finishInProgressScheduledFunctions();
    expect(await decisionOf(f, decisionId)).toMatchObject({ state: "applied", mode: "automatic", auditReason: "canary" });
    expect(await f.t.mutation(execute, { decisionId })).toBe("not_due");
    expect(await f.t.mutation(execute, { decisionId })).toBe("not_due");
    expect(await dealRows(f)).toHaveLength(1);
    await invariants(f);
  });

  it("is retried by the sweep when its wake-up was missed", async () => {
    const f = await automaticFixture();
    const decisionId = await evaluate(f);
    vi.setSystemTime(FIXTURE_NOW + GRACE - 1);
    await f.t.mutation(internal.automation.sweep.dueAutomaticPage, { cursor: null, through: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    await f.t.finishInProgressScheduledFunctions();
    expect(await decisionOf(f, decisionId)).toMatchObject({ state: "ready", mode: "automatic" });
    vi.setSystemTime(FIXTURE_NOW + GRACE);
    await f.t.mutation(internal.automation.sweep.dueAutomaticPage, { cursor: null, through: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    await f.t.finishInProgressScheduledFunctions();
    expect(await decisionOf(f, decisionId)).toMatchObject({ state: "applied", mode: "automatic" });
    expect(await dealRows(f)).toHaveLength(1);
    await invariants(f);
  });

  it("waits while Whop is stale and writes once it is fresh", async () => {
    const f = await automaticFixture();
    const decisionId = await evaluate(f);
    await f.t.run((ctx) => ctx.db.patch("tenantPaymentConnections", f.connectionId, { lastSuccessfulSweepAt: FIXTURE_NOW - 2 * HOUR }));
    vi.setSystemTime(FIXTURE_NOW + GRACE);
    expect(await f.t.mutation(execute, { decisionId })).toBe("waiting");
    expect(await decisionOf(f, decisionId)).toMatchObject({
      state: "ready", mode: "automatic", dueAt: FIXTURE_NOW + GRACE + WHOP_STALE_RETRY_MS,
    });
    expect(await dealRows(f)).toEqual([]);
    await invariants(f);

    // Too early for the new look; then Whop catches up.
    expect(await f.t.mutation(execute, { decisionId })).toBe("not_due");
    vi.setSystemTime(FIXTURE_NOW + GRACE + WHOP_STALE_RETRY_MS);
    await f.t.run((ctx) => ctx.db.patch("tenantPaymentConnections", f.connectionId, { lastSuccessfulSweepAt: Date.now() }));
    expect(await f.t.mutation(execute, { decisionId })).toBe("applied");
    expect(await dealRows(f)).toHaveLength(1);
    await invariants(f);
  });

  it.each([
    ["a re-read changed the amount", (f: Fixture) => f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, {
      totalMinor: 12000, sourceUpdatedAt: FIXTURE_NOW + 60_000,
    }))],
    ["a refund fence arrived during the grace", (f: Fixture) => f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, {
      adverseFencedAt: FIXTURE_NOW + 60_000, adverseFenceRevision: 1,
    }))],
    ["the person reached the deal capacity hold", (f: Fixture) => f.t.run(async (ctx) => {
      for (let i = 1; i < 100; i++) await insertProviderDeal(ctx, { tenantId: f.tenantId, leadId: f.personId, position: "lost" });
    })],
    ["the deal changed closer", (f: Fixture) => f.t.run(async (ctx) => {
      const other = await ctx.db.insert("users", {
        tenantId: f.tenantId, workosUserId: "user_other_closer", email: "other-closer@example.com", role: "closer", isActive: true,
      });
      await ctx.db.patch("opportunities", f.dealId, { assignedCloserId: other });
    })],
  ])("supersedes and writes no cash when %s", async (_name, change) => {
    const f = await automaticFixture();
    const decisionId = await evaluate(f);
    await change(f);
    vi.setSystemTime(FIXTURE_NOW + GRACE);
    expect(await f.t.mutation(execute, { decisionId })).toBe("superseded");
    expect(await decisionOf(f, decisionId)).toMatchObject({ state: "superseded", stopCode: "input_changed" });
    expect(await dealRows(f)).toEqual([]);
    expect(await f.t.run((ctx) => ctx.db.get("opportunities", f.dealId))).toMatchObject({ stage: "booked", outcome: "open" });
    await invariants(f);
  });

  const refusals: Array<[string, (f: Fixture & { sampleId: Id<"automationSamples"> }) => Promise<unknown>, "asked" | "stopped"]> = [
    ["the kind is at ask", (f) => f.t.run(async (ctx) => {
      const settings = (await ctx.db.get("tenants", f.tenantId))!.resultAutomation!;
      const { automatic: _automatic, ...policy } = settings.kinds.payment_win;
      await ctx.db.patch("tenants", f.tenantId, {
        resultAutomation: { ...settings, kinds: { ...settings.kinds, payment_win: { ...policy, mode: "ask" } } },
      });
    }), "asked"],
    ["the certificate lapsed", (f) => f.t.run((ctx) => ctx.db.patch("automationSamples", f.sampleId, {
      status: "lapsed", lapsedAt: FIXTURE_NOW, lapseReason: "rule_changed",
    })), "asked"],
    ["the breaker tripped", (f) => f.t.run(async (ctx) => {
      const settings = (await ctx.db.get("tenants", f.tenantId))!.resultAutomation!;
      await ctx.db.patch("tenants", f.tenantId, {
        resultAutomation: { ...settings, kinds: { ...settings.kinds, payment_win: {
          ...settings.kinds.payment_win, breaker: { trippedAt: FIXTURE_NOW, reason: "wrong_write" },
        } } },
      });
    }), "asked"],
    ["automation is paused", (f) => f.t.run(async (ctx) => {
      const settings = (await ctx.db.get("tenants", f.tenantId))!.resultAutomation!;
      await ctx.db.patch("tenants", f.tenantId, { resultAutomation: { ...settings, enabled: false, pausedAt: FIXTURE_NOW } });
    }), "stopped"],
  ];
  it.each(refusals)("writes nothing when %s", async (_name, change, outcome) => {
    const f = await automaticFixture();
    const decisionId = await evaluate(f);
    await change(f);
    vi.setSystemTime(FIXTURE_NOW + GRACE);
    expect(await f.t.mutation(execute, { decisionId })).toBe(outcome);
    const decision = await decisionOf(f, decisionId);
    if (outcome === "asked") {
      expect(decision).toMatchObject({ state: "ready", mode: "ask" });
      expect(decision?.dueAt).toBeUndefined();
    } else {
      expect(decision).toMatchObject({ state: "stopped", stopCode: "paused" });
    }
    expect(await f.t.mutation(execute, { decisionId })).toBe("not_due");
    expect(await dealRows(f)).toEqual([]);
    expect(await f.t.run((ctx) => ctx.db.query("closerPinnedLines").take(1))).toEqual([]);
    await invariants(f);
  });

  it("audits each of the first ten writes, then samples", async () => {
    const f = await automaticFixture();
    const payments = await f.t.run(async (ctx) => {
      const ids: Id<"providerPayments">[] = [];
      for (let i = 0; i < CANARY_COUNT; i++) {
        const email = `payer-${i}@example.com`;
        const leadId = await insertProviderPerson(ctx, f.tenantId, { email });
        await insertProviderDeal(ctx, { tenantId: f.tenantId, leadId, assignedCloserId: f.closerId });
        ids.push(await insertProviderFact(ctx, f.tenantId, f.connectionId, {
          externalPaymentId: `pay_${i}`, payerEmail: email, reviewState: "needs_person",
        }));
      }
      return ids;
    });
    const decisionIds = [await evaluate(f)];
    for (const id of payments) decisionIds.push(await evaluate(f, id));
    vi.setSystemTime(FIXTURE_NOW + GRACE);
    for (const decisionId of decisionIds) expect(await f.t.mutation(execute, { decisionId })).toBe("applied");
    const receipts = await f.t.run(async (ctx) => await Promise.all(decisionIds.map((id) => ctx.db.get("resultAutomationDecisions", id))));
    expect(receipts.slice(0, CANARY_COUNT).map((row) => row?.auditReason)).toEqual(Array(CANARY_COUNT).fill("canary"));
    const last = receipts[CANARY_COUNT]!;
    expect(last.auditReason === "sampled" ? last.auditOpenDueAt : last.auditWrongFields).toBeDefined();
    expect(last.auditReason).not.toBe("canary");
    const tenant = await f.t.run((ctx) => ctx.db.get("tenants", f.tenantId));
    expect(tenant?.resultAutomation?.kinds.payment_win.automatic?.writes).toBe(CANARY_COUNT + 1);
    await invariants(f);
  });
});

describe("a payment after an automatic refusal", () => {
  function input(deal: Partial<NonNullable<PaymentDecisionInput["deal"]>>): PaymentDecisionInput {
    const paidAt = FIXTURE_NOW - 60_000;
    const opportunityId = "10001opportunities" as Id<"opportunities">;
    return {
      now: FIXTURE_NOW, autoImportAfter: paidAt - 2000, standDown: false,
      target: { kind: "ready", leadId: "10001leads" as Id<"leads">, opportunityId, matchMethod: "checkout_binding" },
      settings: { mode: "automatic", policyVersion: 1, activationVersion: 1 },
      payment: {
        _id: "10001providerPayments" as Id<"providerPayments">, status: "paid", currency: "USD", totalMinor: 10000, paidAt,
        adverseState: "none", billingReason: "one_time", lineItemCount: 1, allocationRevision: 0, sourceUpdatedAt: paidAt,
        reviewState: "needs_person", fenced: false, financing: false, excludedOpportunityIds: [],
      },
      deal: {
        _id: opportunityId, position: "lost", isSideDeal: false, systemLoss: null, createdAt: paidAt - 1000,
        assignedCloserId: "10001users" as Id<"users">, humanResultRevision: 0, storedPaymentCount: 0, personDealCount: 1,
        blockingManualPaymentIds: [], pendingTasks: [], ...deal,
      },
      mapping: { programId: "10001tenantPrograms" as Id<"tenantPrograms">, paymentType: "pif", bindingIds: [], bindingVersions: [] },
      membership: null,
    };
  }

  it("is never automatic: the deal carries the call_refusal_loss gate", () => {
    expect(deriveDecision(input({ callRefusal: true }))).toMatchObject({ wouldWrite: false, gates: ["call_refusal_loss"] });
    expect(deriveDecision(input({}))).toMatchObject({ wouldWrite: false, gates: ["lost_by_person"] });
  });

  async function refusedDeal(f: Fixture, refusal: "automatic" | "confirmed") {
    const lostAt = FIXTURE_NOW - 2 * HOUR;
    await f.t.run(async (ctx) => {
      const sampleId = await ctx.db.insert("automationSamples", {
        tenantId: f.tenantId, kind: "refusal_loss", ruleVersion: "call-rule@1", target: 300, status: "certified",
        certifiedAt: lostAt - HOUR, createdAt: lostAt - HOUR,
      });
      const automatic = refusal === "automatic";
      await transitionOpportunity(ctx, f.dealId, {
        to: { stage: "closed", outcome: "lost" },
        fields: { lostReason: "call_refusal", lostAt, lostByUserId: automatic ? undefined : f.closerId },
        source: automatic ? "system" : "closer", actorUserId: automatic ? undefined : f.closerId, occurredAt: lostAt,
      });
      await ctx.db.insert("resultAutomationDecisions", {
        tenantId: f.tenantId, kind: "refusal_loss", mode: automatic ? "automatic" : "ask", state: "applied",
        inputKey: "a".repeat(64), vetoKey: "b".repeat(64), ruleVersion: "call-rule@1", policyVersion: 1,
        activationVersion: 1, humanResultRevision: 0, wouldWrite: true, gates: [], leadId: f.personId,
        opportunityId: f.dealId, assignedCloserId: f.closerId,
        evidence: { allocationRevision: 0, sourceUpdatedAt: lostAt, bindingIds: [], bindingVersions: [] },
        createdAt: lostAt - HOUR, resolvedAt: lostAt, appliedVia: automatic ? "automatic" : "meeting_confirm",
        resolvedByUserId: automatic ? undefined : f.closerId,
        certificateSampleId: automatic ? sampleId : undefined,
        humanResultRevisionAfter: 0,
      });
    });
  }

  it("goes to Billing, where a person's pick wins the deal through provider_payment_after_call_refusal", async () => {
    const f = await automaticFixture();
    await refusedDeal(f, "automatic");
    await invariants(f);
    const { decisionId } = await f.t.run((ctx) => evaluateSubject(ctx, {
      tenantId: f.tenantId, providerPaymentId: f.providerPaymentId, cause: "provider_read", now: FIXTURE_NOW,
    }));
    // The payment still names the deal: Billing sees it, with the gate, and nothing is due.
    const held = decisionId && await decisionOf(f, decisionId);
    if (held) {
      expect(held).toMatchObject({ state: "needs_person", mode: "ask", wouldWrite: false });
      expect(held.gates).toContain("call_refusal_loss");
      expect(held.dueAt).toBeUndefined();
    }
    const automatic = await f.t.run((ctx) => ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_opportunityId_and_state", (q) =>
        q.eq("tenantId", f.tenantId).eq("opportunityId", f.dealId).eq("state", "ready")).take(5));
    expect(automatic).toEqual([]);

    const args = await pin(f);
    expect(args.decisionId).toBeUndefined();
    const applied = await f.admin.mutation(confirm.confirmWhopPayment, args);
    if (!applied.ok) throw new Error(applied.code);
    const [deal, event] = await f.t.run(async (ctx) => [
      await ctx.db.get("opportunities", f.dealId),
      (await ctx.db.query("domainEvents").withIndex("by_tenantId_and_eventType_and_occurredAt", (q) =>
        q.eq("tenantId", f.tenantId).eq("eventType", "opportunity.stage_changed")).take(5)).at(-1),
    ] as const);
    expect(deal).toMatchObject({ stage: "closed", outcome: "won", paymentReceivedAt: FIXTURE_NOW });
    expect(deal?.lostReason).toBeUndefined();
    expect(JSON.parse(event?.metadata ?? "{}")).toMatchObject({ exception: "provider_payment_after_call_refusal" });
    expect(event).toMatchObject({ source: "admin", actorUserId: f.adminId });
    const [row] = await dealRows(f);
    expect(row).toMatchObject({ recordedByUserId: f.adminId, origin: "provider" });
    expect(await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", row.automationDecisionId!)))
      .toMatchObject({ mode: "ask", appliedVia: "billing", before: { position: "system_loss" } });
    await invariants(f);
  });

  it("keeps a refusal a person confirmed theirs", async () => {
    const f = await automaticFixture();
    await refusedDeal(f, "confirmed");
    const { preview } = await f.admin.query(confirm.previewWhopConfirm, {
      providerPaymentId: f.providerPaymentId, opportunityId: f.dealId,
    });
    expect(preview).toEqual({ ok: false, code: "lost_by_person" });
    await invariants(f);
  });
});

