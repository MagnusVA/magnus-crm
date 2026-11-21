import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { insertOtherTenant } from "../../tests/dealStateFixtures";
import { insertProgram } from "../../tests/enrollmentFixtures";
import { storeProofFile } from "../../tests/proofFixtures";
import { assertPaymentInvariants, seedProviderWin } from "../../tests/paymentInvariants";
import {
  FIXTURE_NOW,
  automationPaymentFixture,
  confirmAttendedWhopWin,
  insertProviderBinding,
  insertProviderDeal,
  insertProviderFact,
  insertProviderMeeting,
  insertProviderPerson,
  providerPaymentFixture,
  seedBillingWin,
  seedManualPayment,
  setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";
import { noteHumanResult } from "../automation/humanResult";
import { patchMeetingLifecycle } from "../lib/meetingLifecycle";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import type { ExcludeArgs } from "./exclude";
import { findPaymentTarget, refreshProviderPaymentReview } from "./match";

// Taking a payment out (build contract §2.6, row X): every scenario asserts
// the sixteen payment invariants after each step.

const WIN_AT = FIXTURE_NOW - 10_000;
const ALLOWED_STRINGS = [/^[a-z_]+$/, /^[A-Z]{3}$/, /^[0-9a-f]{64}$/, /^\d+[A-Za-z]+$/];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

type Fixture = Awaited<ReturnType<typeof providerPaymentFixture>>;
type Caller = Fixture["admin"];

async function billingWin(options: {
  dealPosition?: "booked" | "follow_up" | "lost";
  lostReason?: "no_show" | "canceled";
  meetingAt?: number;
  reminder?: boolean;
} = {}) {
  const f = await providerPaymentFixture({
    dealPosition: options.dealPosition, lostReason: options.lostReason, fact: { reviewState: "needs_person" },
  });
  const opportunityId = f.dealId!;
  const { t, tenantId, closerId } = f;
  const seeded = await t.run(async (ctx) => {
    if (options.dealPosition === "lost") await patchOpportunityLifecycle(ctx, opportunityId, { lostAt: FIXTURE_NOW - 50_000 });
    const meetingId = options.meetingAt === undefined ? undefined : await insertProviderMeeting(ctx, {
      tenantId, opportunityId, closerId, scheduledAt: options.meetingAt,
    });
    const taskId = options.reminder ? await ctx.db.insert("followUps", {
      tenantId, opportunityId, leadId: f.personId, closerId, type: "manual_reminder", contactMethod: "text",
      reminderScheduledAt: FIXTURE_NOW + 3_600_000, reason: "closer_initiated", status: "pending",
      createdAt: FIXTURE_NOW - 60_000, createdSource: "closer", createdByUserId: closerId,
    }) : undefined;
    const win = await seedBillingWin(ctx, {
      tenantId, opportunityId, providerPaymentId: f.providerPaymentId, programId: f.programId,
      closerId, approverId: f.adminId, recordedAt: WIN_AT, expireTaskIds: taskId ? [taskId] : [],
    });
    return { ...win, meetingId, taskId };
  });
  const invariant = () => assertPaymentInvariants(t, { tenantId });
  return { ...f, opportunityId, ...seeded, invariant };
}

async function preview(caller: Caller, paymentRecordId: Id<"paymentRecords">, cause: ExcludeArgs["cause"] = "wrong_match") {
  return await caller.query(api.payments.exclude.previewExclusion, { paymentRecordId, cause });
}

it("returns a refusal when the payment is on a deal that is not won", async () => {
  const f = await providerPaymentFixture({ dealPosition: "booked" });
  const paymentRecordId = await f.t.run((ctx) => seedManualPayment(ctx, f, {
    opportunityId: f.dealId!, programId: f.programId, recordedAt: WIN_AT,
  }));
  const result = await preview(f.admin, paymentRecordId);
  expect(result).toMatchObject({
    refusal: "deal_not_won", undo: { allowed: false }, dispositionRequired: false,
    allowedDispositions: [], cashDeltaByCurrency: [],
  });
});

async function exclude(
  caller: Caller,
  args: Omit<ExcludeArgs, "expectedFingerprint" | "voidReason"> & { expectedFingerprint?: string },
) {
  const expectedFingerprint = args.expectedFingerprint ?? (await preview(caller, args.paymentRecordId, args.cause)).fingerprint;
  return await caller.mutation(api.payments.exclude.excludePayment, { ...args, expectedFingerprint });
}

async function recordAttendance(f: Fixture, meetingId: Id<"meetings">, status: "held" | "no_show") {
  await f.t.run(async (ctx) => {
    await patchMeetingLifecycle(ctx, meetingId, status === "held"
      ? { status, heldMarkedAt: FIXTURE_NOW - 1000 }
      : { status, noShowMarkedAt: FIXTURE_NOW - 1000 });
    await noteHumanResult(ctx, f.dealId!, { tenantId: f.tenantId, userId: f.closerId });
  });
}

function readAll(f: Fixture, paymentRecordId: Id<"paymentRecords">) {
  return f.t.run(async (ctx) => ({
    row: await ctx.db.get("paymentRecords", paymentRecordId),
    fact: await ctx.db.get("providerPayments", f.providerPaymentId),
    deal: await ctx.db.get("opportunities", f.dealId!),
    corrections: await ctx.db.query("paymentCorrections")
      .withIndex("by_tenantId_and_opportunityId_and_createdAt", (q) => q.eq("tenantId", f.tenantId).eq("opportunityId", f.dealId!))
      .take(20),
    pending: (await ctx.db.query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) => q.eq("opportunityId", f.dealId!).eq("status", "pending"))
      .take(20)).filter((task) => task.reason !== "stale_opportunity_nudge"),
    voided: await ctx.db.query("domainEvents")
      .withIndex("by_tenantId_and_eventType_and_occurredAt", (q) => q.eq("tenantId", f.tenantId).eq("eventType", "payment.voided"))
      .take(20),
  }));
}

function expectWordless(rows: Doc<"paymentCorrections">[]) {
  const strings: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  rows.forEach(walk);
  expect(strings.length).toBeGreaterThan(0);
  for (const text of strings) expect(ALLOWED_STRINGS.some((pattern) => pattern.test(text)), text).toBe(true);
}

describe("one-tap undo of a Billing confirmation", () => {
  it("returns the deal to Booked, keeps provenance, and the matcher never proposes the deal again", async () => {
    const f = await billingWin({ meetingAt: FIXTURE_NOW + 86_400_000 });
    await f.invariant();
    const before = await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", f.decisionId));
    const shown = await preview(f.admin, f.paymentRecordId);
    expect(shown).toMatchObject({
      survivors: [], undo: { allowed: true, result: "undo_booked" }, dispositionRequired: true,
      allowedDispositions: ["lost", "follow_up"], cashDeltaByCurrency: [{ currency: "USD", amountMinor: -10000 }],
    });
    expect(shown.refusal).toBeUndefined();

    const args = { paymentRecordId: f.paymentRecordId, cause: "wrong_match", level: "undo", expectedFingerprint: shown.fingerprint } as const;
    const result = await f.admin.mutation(api.payments.exclude.excludePayment, args);
    expect(result).toMatchObject({ ok: true, alreadyApplied: false });
    const state = await readAll(f, f.paymentRecordId);
    expect(state.row).toMatchObject({ status: "disputed", providerPaymentId: f.providerPaymentId, statusChangedAt: FIXTURE_NOW });
    expect(state.fact).toMatchObject({ allocationRevision: 2, excludedOpportunityIds: [f.opportunityId] });
    expect(state.fact?.paymentRecordId).toBeUndefined();
    expect(state.deal).toMatchObject({
      stage: "booked", outcome: "open", humanResultRevision: 2, latestActivityAt: before?.before?.latestActivityAt,
    });
    expect(state.deal?.paymentReceivedAt).toBeUndefined();
    expect(state.deal?.soldProgramId).toBeUndefined();
    expect(state.corrections).toMatchObject([{
      operation: "exclude", level: "undo", cause: "wrong_match", result: "undo_booked", decisionId: f.decisionId,
      vetoedOpportunityId: f.opportunityId, before: { paymentStatus: "recorded", providerReviewState: "recorded", dealPosition: "won" },
      after: { dealPosition: "booked", allocationRevision: 2, humanResultRevision: 2 },
    }]);
    expect(state.voided).toMatchObject([{ toStatus: "disputed" }]);
    expect(JSON.parse(state.voided[0].metadata!)).toMatchObject({
      cause: "wrong_match", level: "undo", result: "undo_booked", correctionId: state.corrections[0]._id,
    });
    const after = await f.t.run(async (ctx) => ({
      decision: await ctx.db.get("resultAutomationDecisions", f.decisionId),
      meeting: await ctx.db.get("meetings", f.meetingId!),
      lines: await ctx.db.query("closerPinnedLines")
        .withIndex("by_tenantId_and_userId_and_dismissedAt_and_createdAt", (q) => q.eq("tenantId", f.tenantId).eq("userId", f.closerId))
        .take(5),
    }));
    expect(after.decision).toMatchObject({ state: "undone", correctionId: state.corrections[0]._id });
    expect(after.meeting?.status).toBe("scheduled");
    expect(after.meeting?.attendanceOwedSince).toBeUndefined();
    expect(after.lines).toMatchObject([{ kind: "win_removed", dealPositionAfter: "booked", amountMinor: 10000 }]);
    expectWordless(state.corrections);
    await f.invariant();

    // A redelivered read refreshes the review: the vetoed deal is never proposed.
    await f.t.run((ctx) => refreshProviderPaymentReview(ctx, f.providerPaymentId));
    const fact = (await f.t.run((ctx) => ctx.db.get("providerPayments", f.providerPaymentId)))!;
    expect(fact).toMatchObject({ reviewState: "needs_person", reviewReason: "excluded_wrong_match" });
    expect(fact.candidateOpportunityId).toBeUndefined();
    expect(await f.t.run(async (ctx) => findPaymentTarget(ctx, (await ctx.db.get("providerPayments", f.providerPaymentId))!)))
      .toEqual({ kind: "needs_person", reason: "excluded_wrong_match", candidateLeadId: f.personId, candidateOpportunityIds: [] });
    await f.invariant();

    // The same tap again is the same request.
    expect(await f.admin.mutation(api.payments.exclude.excludePayment, args))
      .toEqual({ ok: true, alreadyApplied: true, correctionId: state.corrections[0]._id });
    expect((await readAll(f, f.paymentRecordId)).voided).toHaveLength(1);
    await f.invariant();
  });

  it("returns the deal to Follow-up with the task the win expired", async () => {
    const f = await billingWin({ dealPosition: "follow_up", reminder: true });
    await f.invariant();
    expect((await preview(f.admin, f.paymentRecordId, "refund")).undo).toEqual({ allowed: true, result: "undo_follow_up" });
    const result = await exclude(f.admin, { paymentRecordId: f.paymentRecordId, cause: "refund", level: "undo" });
    expect(result.ok).toBe(true);
    const state = await readAll(f, f.paymentRecordId);
    expect(state.deal).toMatchObject({ stage: "follow_up", outcome: "open" });
    expect(state.pending.map((task) => task._id)).toEqual([f.taskId]);
    expect(state.pending[0]).toMatchObject({ status: "pending", reminderScheduledAt: FIXTURE_NOW + 3_600_000 });
    expect(state.corrections[0]).toMatchObject({ result: "undo_follow_up", tasks: [{ followUpId: f.taskId, change: "reopened" }] });
    // A refund keeps the payment's resolution open for Billing, with no veto.
    expect(state.fact?.excludedOpportunityIds).toBeUndefined();
    await f.invariant();
  });

  it("returns a system loss with its original code and time, and no person", async () => {
    const f = await billingWin({ dealPosition: "lost", lostReason: "no_show" });
    await f.invariant();
    const result = await exclude(f.admin, { paymentRecordId: f.paymentRecordId, cause: "chargeback", level: "undo" });
    expect(result.ok).toBe(true);
    const { deal, corrections } = await readAll(f, f.paymentRecordId);
    expect(deal).toMatchObject({ stage: "closed", outcome: "lost", lostReason: "no_show", lostAt: FIXTURE_NOW - 50_000 });
    expect(deal?.lostByUserId).toBeUndefined();
    expect(corrections[0]).toMatchObject({ result: "undo_system_loss", after: { dealPosition: "lost", lostAt: FIXTURE_NOW - 50_000 } });
    await f.invariant();
  });

  it("closes the deal as the system loss when Calendly canceled the meeting since the win", async () => {
    const f = await billingWin({ meetingAt: FIXTURE_NOW + 86_400_000 });
    await f.t.run((ctx) => patchMeetingLifecycle(ctx, f.meetingId!, { status: "canceled", canceledAt: FIXTURE_NOW - 5000 }));
    await f.invariant();
    expect((await preview(f.admin, f.paymentRecordId)).undo).toEqual({ allowed: true, result: "system_loss_on_undo" });
    const result = await exclude(f.admin, { paymentRecordId: f.paymentRecordId, cause: "wrong_match", level: "undo" });
    expect(result.ok).toBe(true);
    const { deal, corrections } = await readAll(f, f.paymentRecordId);
    expect(deal).toMatchObject({ stage: "closed", outcome: "lost", lostReason: "canceled", lostAt: FIXTURE_NOW - 5000 });
    expect(deal?.lostByUserId).toBeUndefined();
    expect(corrections[0].result).toBe("system_loss_on_undo");
    await f.invariant();
  });

  it("disables the membership binding anchored on the undone payment", async () => {
    const f = await billingWin({ meetingAt: FIXTURE_NOW + 86_400_000 });
    const bindingId = await f.t.run(async (ctx) => {
      await ctx.db.patch("providerPayments", f.providerPaymentId, { membershipId: "mem_fixture" });
      return await insertProviderBinding(ctx, {
        ...f, externalId: "mem_fixture",
        binding: { kind: "membership_deal", leadId: f.personId, opportunityId: f.opportunityId, anchorPaymentRecordId: f.paymentRecordId },
      });
    });
    await f.invariant();
    expect((await exclude(f.admin, { paymentRecordId: f.paymentRecordId, cause: "refund", level: "undo" })).ok).toBe(true);
    expect(await f.t.run((ctx) => ctx.db.get("paymentProviderBindings", bindingId)))
      .toMatchObject({ enabled: false, disabledReason: "anchor_undone", version: 2 });
    await f.invariant();
  });
});

describe("the reviewed correction", () => {
  it("blocks amount changes to Whop-origin cash but allows program and type corrections", async () => {
    const f = await billingWin();
    const { paymentRecordId } = f;
    const original = await readAll(f, paymentRecordId);
    const programId = await f.t.run((ctx) => insertProgram(ctx, f.tenantId, "Corrected program"));
    await expect(f.admin.mutation(api.billing.mutations.correctPayment, {
      paymentRecordId, amount: 150, programId, reason: "Synthetic adjustment",
    })).rejects.toMatchObject({ data: {
      code: "payment.provider_amount_locked",
      message: "This payment came from Whop. Take it out and record the right one instead.",
    } });
    expect(await readAll(f, paymentRecordId)).toEqual(original);
    expect(await f.admin.mutation(api.billing.mutations.correctPayment, {
      paymentRecordId, amount: 100, programId, paymentType: "split", reason: "Synthetic correction",
    })).toMatchObject({ changed: true });
    expect((await readAll(f, paymentRecordId)).row)
      .toMatchObject({ origin: "provider", amountMinor: 10_000, currency: "USD", programId, paymentType: "split" });
    await f.invariant();
  });

  it("allows an amount correction to hand-recorded cash linked to Whop evidence", async () => {
    const f = await providerPaymentFixture({ source: "side_deal" });
    const { paymentId } = await f.closer.mutation(api.sideDeals.logPayment.logPayment, {
      opportunityId: f.dealId!, amount: 100, currency: "USD", paymentType: "pif",
      programId: f.programId, proofFileId: await storeProofFile(f.t),
    });
    await f.admin.mutation(api.payments.review.linkToPaymentRecord, {
      providerPaymentId: f.providerPaymentId, paymentRecordId: paymentId, expectedAllocationRevision: 0,
    });
    expect(await f.admin.mutation(api.billing.mutations.correctPayment, {
      paymentRecordId: paymentId, amount: 150, reason: "Synthetic correction",
    })).toMatchObject({ changed: true });
    expect((await readAll(f, paymentId)).row)
      .toMatchObject({ origin: "closer_side_deal", amountMinor: 15_000, providerPaymentId: f.providerPaymentId });
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("excludes a payment despite more than 50 unrelated completed reminders", async () => {
    const f = await billingWin();
    await f.t.run(async (ctx) => {
      for (let index = 0; index < 51; index++) {
        await ctx.db.insert("followUps", {
          tenantId: f.tenantId, opportunityId: f.opportunityId, leadId: f.personId, closerId: f.closerId,
          type: "manual_reminder", status: "completed", reason: "closer_initiated",
          completionOutcome: "no_response_rescheduled", createdAt: WIN_AT - 2000 - index,
          completedAt: WIN_AT - 1000 - index,
        });
      }
    });

    const shown = await preview(f.admin, f.paymentRecordId);
    expect(shown.refusal).toBeUndefined();
    expect(await exclude(f.admin, {
      paymentRecordId: f.paymentRecordId, cause: "wrong_match", level: "reviewed", disposition: "lost",
      expectedFingerprint: shown.fingerprint,
    })).toMatchObject({ ok: true, alreadyApplied: false });
    await f.invariant();
  });

  it.each(["exclusion", "apply"] as const)("allows payment %s after 21 removed membership confirmations", async (action) => {
    const f = await billingWin();
    const membershipId = "mem_removed_history";
    await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, { membershipId }));
    for (let round = 0; round < 21; round++) {
      const control = await f.admin.query(api.payments.bindings.getMembershipControl, {
        providerPaymentId: f.providerPaymentId,
      });
      if (control?.kind !== "confirm") throw new Error("Expected membership confirmation to be available");
      const bindingId = await f.admin.mutation(api.payments.bindings.confirmMembership, {
        providerPaymentId: f.providerPaymentId,
        expectedMembershipId: membershipId,
        expectedAllocationRevision: control.allocationRevision,
        expectedBindingVersion: control.bindingVersion,
      });
      await f.admin.mutation(api.payments.bindings.removeMembershipConfirmation, { bindingId });
    }

    if (action === "exclusion") {
      const shown = await preview(f.admin, f.paymentRecordId);
      expect(shown.refusal).toBeUndefined();
      expect(await exclude(f.admin, {
        paymentRecordId: f.paymentRecordId, cause: "wrong_match", level: "reviewed", disposition: "lost",
        expectedFingerprint: shown.fingerprint,
      })).toMatchObject({ ok: true, alreadyApplied: false });
    } else {
      const providerPaymentId = await f.t.run(async (ctx) => {
        await setPaymentFixtureModes(ctx, f);
        return await insertProviderFact(ctx, f.tenantId, f.connectionId, {
          externalPaymentId: "pay_after_removals", reviewState: "needs_person",
        });
      });
      const args = { providerPaymentId, opportunityId: f.opportunityId };
      const { preview: shown } = await f.admin.query(api.payments.confirm.previewWhopConfirm, args);
      expect(shown).toMatchObject({ ok: true, kind: "additional_payment" });
      if (!shown.ok) throw new Error(shown.code);
      expect(await f.admin.mutation(api.payments.confirm.confirmWhopPayment, {
        ...args, expectedFingerprint: shown.fingerprint, expectedAllocationRevision: shown.allocationRevision,
      })).toMatchObject({ ok: true, alreadyApplied: false });
    }
    await f.invariant();
  });

  it("lands a closer's attended confirmation at Follow-up with one next step, never Booked", async () => {
    const f = await providerPaymentFixture();
    const { paymentRecordId, meetingId } = await confirmAttendedWhopWin(f);
    const invariant = () => assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    await invariant();
    const held = await f.t.run((ctx) => ctx.db.get("meetings", meetingId));
    expect(held).toMatchObject({ status: "held" });

    expect((await preview(f.admin, paymentRecordId)).undo).toEqual({ allowed: false });
    expect(await exclude(f.admin, { paymentRecordId, cause: "wrong_match", level: "undo" }))
      .toEqual({ ok: false, code: "needs_review" });
    expect(await exclude(f.admin, { paymentRecordId, cause: "wrong_match", level: "reviewed" }))
      .toEqual({ ok: false, code: "disposition_required" });
    await expect(exclude(f.admin, { paymentRecordId, cause: "wrong_match", level: "reviewed", disposition: "follow_up" }))
      .rejects.toMatchObject({ data: { code: "payment.contact_method_required" } });
    expect((await readAll(f, paymentRecordId)).row?.status).toBe("recorded");
    await invariant();

    const result = await exclude(f.admin, {
      paymentRecordId, cause: "wrong_match", level: "reviewed", disposition: "follow_up", followUpContactMethod: "call",
    });
    expect(result.ok).toBe(true);
    const state = await readAll(f, paymentRecordId);
    expect(state.deal).toMatchObject({ stage: "follow_up", outcome: "open" });
    expect(state.deal?.paymentReceivedAt).toBeUndefined();
    expect(state.pending).toMatchObject([{
      type: "manual_reminder", closerId: f.closerId, reminderScheduledAt: FIXTURE_NOW, contactMethod: "call",
      reason: "admin_initiated", createdSource: "admin", createdByUserId: f.adminId,
    }]);
    expect(state.corrections[0]).toMatchObject({ result: "follow_up", level: "reviewed", tasks: [{ change: "created" }] });
    expect(await f.t.run((ctx) => ctx.db.get("meetings", meetingId))).toMatchObject({ status: "held", heldMarkedAt: held!.heldMarkedAt });
    expect(await f.t.run(async (ctx) => (await ctx.db.query("resultAutomationDecisions").take(5)).map((d) => d.state)))
      .toContain("corrected");
    expectWordless(state.corrections);
    await invariant();
  });

  it.each(["held", "no_show"] as const)(
    "a wrong Whop win followed by a true %s keeps attendance through exclusion and re-match",
    async (attendance) => {
      const f = await billingWin({ meetingAt: FIXTURE_NOW - 1_800_000 });
      await recordAttendance(f, f.meetingId!, attendance);
      await f.invariant();
      expect((await preview(f.admin, f.paymentRecordId)).undo).toEqual({ allowed: false });
      const result = await exclude(f.admin, {
        paymentRecordId: f.paymentRecordId, cause: "wrong_match", level: "reviewed",
        disposition: "follow_up", followUpContactMethod: "text",
      });
      expect(result.ok).toBe(true);
      await f.invariant();

      // Billing re-matches the payment to the right person's deal.
      const otherDealId = await f.t.run(async (ctx) => {
        const otherPerson = await insertProviderPerson(ctx, f.tenantId, { fullName: "Sam Rivera", email: "sam@example.com" });
        const dealId = await insertProviderDeal(ctx, { tenantId: f.tenantId, leadId: otherPerson, assignedCloserId: f.closerId });
        await seedProviderWin(ctx, {
          tenantId: f.tenantId, opportunityId: dealId, providerPaymentId: f.providerPaymentId, programId: f.programId,
          closerId: f.closerId, approverId: f.adminId, recordedAt: FIXTURE_NOW,
        });
        return dealId;
      });
      const rows = await f.t.run((ctx) => ctx.db.query("paymentRecords")
        .withIndex("by_tenantId_and_providerPaymentId", (q) => q.eq("tenantId", f.tenantId).eq("providerPaymentId", f.providerPaymentId))
        .take(10));
      expect(rows.filter((row) => row.status !== "disputed").map((row) => row.opportunityId)).toEqual([otherDealId]);
      expect(rows.find((row) => row._id === f.paymentRecordId)).toMatchObject({ status: "disputed", providerPaymentId: f.providerPaymentId });
      expect(await f.t.run((ctx) => ctx.db.get("meetings", f.meetingId!))).toMatchObject({ status: attendance });
      await f.invariant();
    },
  );

  it("requires a disposition for a full refund of the only payment after attendance", async () => {
    const f = await billingWin({ meetingAt: FIXTURE_NOW - 1_800_000 });
    await recordAttendance(f, f.meetingId!, "held");
    await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, { adverseState: "refunded", refundedMinor: 10000 }));
    await f.invariant();
    expect(await exclude(f.admin, { paymentRecordId: f.paymentRecordId, cause: "refund", level: "reviewed" }))
      .toEqual({ ok: false, code: "disposition_required" });
    const result = await exclude(f.admin, { paymentRecordId: f.paymentRecordId, cause: "refund", level: "reviewed", disposition: "lost" });
    expect(result.ok).toBe(true);
    const { deal, pending } = await readAll(f, f.paymentRecordId);
    expect(deal).toMatchObject({ stage: "closed", outcome: "lost", lostReason: "payment_excluded", lostByUserId: f.adminId, lostAt: FIXTURE_NOW });
    expect(deal?.paymentReceivedAt).toBeUndefined();
    expect(pending).toEqual([]);
    expect(await f.t.run((ctx) => ctx.db.get("meetings", f.meetingId!))).toMatchObject({ status: "held" });
    await f.invariant();
  });

  it("keeps the deal won while another payment counts, then excludes the payment that became first", async () => {
    const f = await billingWin({ meetingAt: FIXTURE_NOW + 86_400_000 });
    const laterAt = FIXTURE_NOW - 5000;
    const laterId = await f.t.run((ctx) => seedManualPayment(ctx, f, { opportunityId: f.opportunityId, programId: f.programId, recordedAt: laterAt }));
    await f.invariant();

    const shown = await preview(f.admin, f.paymentRecordId, "refund");
    expect(shown).toMatchObject({ survivors: [laterId], newFirstPaymentAt: laterAt, dispositionRequired: false, allowedDispositions: [] });
    expect(await exclude(f.admin, { paymentRecordId: f.paymentRecordId, cause: "refund", level: "reviewed", disposition: "lost" }))
      .toEqual({ ok: false, code: "disposition_not_allowed" });
    const stageEvents = () => f.t.run(async (ctx) => (await ctx.db.query("domainEvents")
      .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
        q.eq("tenantId", f.tenantId).eq("entityType", "opportunity").eq("entityId", f.opportunityId))
      .take(50)).length);
    const eventsBefore = await stageEvents();
    expect((await exclude(f.admin, { paymentRecordId: f.paymentRecordId, cause: "refund", level: "undo" })).ok).toBe(true);
    let state = await readAll(f, f.paymentRecordId);
    expect(state.deal).toMatchObject({ outcome: "won", paymentReceivedAt: laterAt });
    expect(state.corrections[0]).toMatchObject({ result: "kept_won", after: { dealPosition: "won", paymentReceivedAt: laterAt } });
    expect(await stageEvents()).toBe(eventsBefore);
    await f.invariant();

    // The later payment is now the only one: it has no receipt, so it needs a disposition.
    const later = await preview(f.admin, laterId, "refund");
    expect(later).toMatchObject({ survivors: [], undo: { allowed: false }, dispositionRequired: true });
    expect(await exclude(f.admin, { paymentRecordId: laterId, cause: "refund", level: "undo" })).toEqual({ ok: false, code: "needs_review" });
    expect((await exclude(f.admin, { paymentRecordId: laterId, cause: "refund", level: "reviewed", disposition: "lost" })).ok).toBe(true);
    state = await readAll(f, laterId);
    expect(state.deal).toMatchObject({ outcome: "lost", lostReason: "payment_excluded" });
    expect(state.deal?.paymentReceivedAt).toBeUndefined();
    await f.invariant();
  });

  it("refuses a stale preview after later work and writes nothing", async () => {
    const f = await billingWin({ meetingAt: FIXTURE_NOW + 86_400_000 });
    const shown = await preview(f.admin, f.paymentRecordId);
    // A task added later, without touching the deal.
    await f.t.run((ctx) => ctx.db.insert("followUps", {
      tenantId: f.tenantId, opportunityId: f.opportunityId, leadId: f.personId, closerId: f.closerId,
      type: "manual_reminder", contactMethod: "call", reminderScheduledAt: FIXTURE_NOW + 1000,
      reason: "closer_initiated", status: "pending", createdAt: FIXTURE_NOW, createdSource: "closer",
    }));
    const before = await readAll(f, f.paymentRecordId);
    expect(await exclude(f.admin, {
      paymentRecordId: f.paymentRecordId, cause: "wrong_match", level: "undo", expectedFingerprint: shown.fingerprint,
    })).toEqual({ ok: false, code: "stale_preview" });
    expect(await readAll(f, f.paymentRecordId)).toEqual(before);
    await f.invariant();
  });

  it("A, undo, B, then a duplicate delivery leaves exactly one counting payment", async () => {
    const f = await billingWin({ meetingAt: FIXTURE_NOW + 86_400_000 });
    const shown = await preview(f.admin, f.paymentRecordId);
    const args = { paymentRecordId: f.paymentRecordId, cause: "wrong_match", level: "undo", expectedFingerprint: shown.fingerprint } as const;
    expect((await f.admin.mutation(api.payments.exclude.excludePayment, args)).ok).toBe(true);
    const otherDealId = await f.t.run(async (ctx) => {
      const otherPerson = await insertProviderPerson(ctx, f.tenantId, { fullName: "Sam Rivera", email: "sam@example.com" });
      const dealId = await insertProviderDeal(ctx, { tenantId: f.tenantId, leadId: otherPerson, assignedCloserId: f.closerId });
      await seedProviderWin(ctx, {
        tenantId: f.tenantId, opportunityId: dealId, providerPaymentId: f.providerPaymentId, programId: f.programId,
        closerId: f.closerId, approverId: f.adminId, recordedAt: FIXTURE_NOW,
      });
      return dealId;
    });
    await f.invariant();
    // The delivery again: a fresh read and the same approval resubmitted.
    await f.t.run((ctx) => refreshProviderPaymentReview(ctx, f.providerPaymentId));
    expect((await f.admin.mutation(api.payments.exclude.excludePayment, args))).toMatchObject({ ok: true, alreadyApplied: true });
    const counting = await f.t.run(async (ctx) => (await ctx.db.query("paymentRecords")
      .withIndex("by_tenantId_and_providerPaymentId", (q) => q.eq("tenantId", f.tenantId).eq("providerPaymentId", f.providerPaymentId))
      .take(10)).filter((row) => row.status !== "disputed"));
    expect(counting.map((row) => row.opportunityId)).toEqual([otherDealId]);
    expect((await f.t.run((ctx) => ctx.db.get("providerPayments", f.providerPaymentId)))?.paymentRecordId).toBe(counting[0]._id);
    await f.invariant();
  });
});

describe("approvals", () => {
  it("gives the second admin submitting the same fingerprint alreadyApplied", async () => {
    const f = await automationPaymentFixture({ fact: { reviewState: "needs_person" } });
    const { paymentRecordId } = await f.t.run((ctx) => seedBillingWin(ctx, {
      tenantId: f.tenantId, opportunityId: f.dealId!, providerPaymentId: f.providerPaymentId, programId: f.programId,
      closerId: f.closerId, approverId: f.adminId, recordedAt: WIN_AT,
    }));
    const fromAdmin = await preview(f.admin, paymentRecordId);
    const fromOwner = await preview(f.owner, paymentRecordId);
    expect(fromOwner.fingerprint).toBe(fromAdmin.fingerprint);
    const args = {
      paymentRecordId, cause: "wrong_match", level: "reviewed", disposition: "lost", expectedFingerprint: fromAdmin.fingerprint,
    } as const;
    const first = await f.admin.mutation(api.payments.exclude.excludePayment, args);
    const second = await f.owner.mutation(api.payments.exclude.excludePayment, args);
    expect(first).toMatchObject({ ok: true, alreadyApplied: false });
    expect(second).toEqual({ ok: true, alreadyApplied: true, correctionId: first.ok ? first.correctionId : undefined });
    expect(await f.t.run((ctx) => ctx.db.query("paymentCorrections").take(5))).toHaveLength(1);
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("needs billing:correct with Billing Ops, and never reads another tenant's payment", async () => {
    const f = await billingWin({ meetingAt: FIXTURE_NOW + 86_400_000 });
    await expect(preview(f.closer, f.paymentRecordId)).rejects.toThrow();
    await expect(f.closer.mutation(api.payments.exclude.excludePayment, {
      paymentRecordId: f.paymentRecordId, cause: "wrong_match", level: "undo", expectedFingerprint: "0".repeat(64),
    })).rejects.toThrow();

    const foreignId = await f.t.run(async (ctx) => {
      const other = await insertOtherTenant(ctx);
      const programId = await insertProgram(ctx, f.tenantId, "Other program");
      const otherPerson = await insertProviderPerson(ctx, other);
      const otherDeal = await insertProviderDeal(ctx, { tenantId: other, leadId: otherPerson, position: "won" });
      return await ctx.db.insert("paymentRecords", {
        tenantId: other, opportunityId: otherDeal, amountMinor: 100, currency: "USD", programId,
        programName: "Program", paymentType: "pif", status: "recorded", recordedAt: FIXTURE_NOW,
        origin: "admin_meeting", recordedByUserId: f.adminId, attributedCloserId: f.closerId,
      });
    });
    await expect(preview(f.admin, foreignId)).rejects.toMatchObject({ data: { code: "payment.not_found" } });
    await expect(f.admin.mutation(api.payments.exclude.excludePayment, {
      paymentRecordId: foreignId, cause: "refund", level: "reviewed", disposition: "lost", expectedFingerprint: "0".repeat(64),
    })).rejects.toMatchObject({ data: { code: "payment.not_found" } });

    await f.t.run((ctx) => ctx.db.patch("tenants", f.tenantId, { billingOpsEnabled: false }));
    await expect(preview(f.admin, f.paymentRecordId)).rejects.toThrow("Billing Ops");
    expect((await readAll(f, f.paymentRecordId)).row?.status).toBe("recorded");
    await f.invariant();
  });
});
