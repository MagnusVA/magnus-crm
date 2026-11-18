import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { api, internal } from "../_generated/api";
import { insertCloserMeeting, insertTask } from "../../tests/closerPipelineFixtures";
import { insertProgram } from "../../tests/enrollmentFixtures";
import { insertProgram as insertMcpProgram } from "../../tests/closerPipelineDeskFixtures";
import { assertPaymentInvariants, seedProviderWin } from "../../tests/paymentInvariants";
import {
  FIXTURE_NOW,
  FIXTURE_PAID_AT,
  insertPaymentFixtureConnection,
  insertProviderBinding,
  insertProviderDeal,
  insertProviderFact,
  insertProviderPerson,
  PAYER_EMAIL,
  providerPaymentFixture,
  PRODUCT_ID,
  VARIANT_ID,
  setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";
import { storeProofFile } from "../../tests/proofFixtures";
import { secondOpinionHarness } from "../../tests/secondOpinionHarness";
import { callTool, testCaller } from "../../tests/mcpHarness";
import { mcpToolsFixture } from "../../tests/mcpToolsFixtures";
import { insertMeetingAggregate, insertOpportunityAggregate } from "../reporting/writeHooks";
import { evaluateSubject } from "../automation/decisions";
import { noteHumanResult } from "../automation/humanResult";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function meetingFixture() {
  const f = await providerPaymentFixture({ fact: { reviewState: "needs_person" } });
  const opportunityId = f.dealId!;
  const { t, tenantId, closerId, providerPaymentId } = f;
  const { meetingId, otherMeetingId, decisionId } = await t.run(async (ctx) => {
    await setPaymentFixtureModes(ctx, f);
    const meeting = (scheduledAt: number) => insertCloserMeeting(ctx, {
      tenantId, opportunityId, closerId, status: "scheduled", scheduledAt,
    });
    const meetingId = await meeting(FIXTURE_NOW - 1_800_000);
    const otherMeetingId = await meeting(FIXTURE_NOW + 86_400_000);
    await insertMeetingAggregate(ctx, meetingId);
    await insertMeetingAggregate(ctx, otherMeetingId);
    await ctx.db.patch("paymentProviderBindings", f.variantBindingId, {
      binding: { kind: "variant_type", paymentType: "deposit" },
    });
    const { decisionId } = await evaluateSubject(ctx, { tenantId, providerPaymentId, now: FIXTURE_NOW, cause: "sweep" });
    if (!decisionId) throw new Error("Expected a ready Whop decision for the fixture");
    return { meetingId, otherMeetingId, decisionId };
  });
  const args = {
    opportunityId, meetingId, programId: f.programId, amount: 100, currency: "USD", paymentType: "deposit" as const,
  };
  const confirm = { kind: "confirm" as const, providerPaymentId, decisionId, expectedAllocationRevision: 0 };
  const sameMoney = {
    kind: "same_money" as const, providerPaymentId, expectedAllocationRevision: 0, acknowledgeAmountDifference: false,
  };
  const invariant = () => assertPaymentInvariants(t, { tenantId });
  return { ...f, opportunityId, meetingId, otherMeetingId, args, confirm, sameMoney, decisionId, invariant };
}

describe("confirming a Whop payment", () => {
  it.each(["several open deals", "an excluded deal"] as const)(
    "keeps a Whop payment with %s in Billing and requires proof for a manual save",
    async (reason) => {
      const f = await meetingFixture();
      await f.t.run(async (ctx) => {
        if (reason === "several open deals") {
          await insertProviderDeal(ctx, { ...f, leadId: f.personId, assignedCloserId: f.closerId });
        } else {
          await ctx.db.patch("providerPayments", f.providerPaymentId, { excludedOpportunityIds: [f.opportunityId] });
        }
      });
      for (const provider of [{ ...f.confirm, decisionId: undefined }, f.sameMoney]) {
        await expect(f.closer.mutation(api.closer.payments.logPayment, { ...f.args, provider }))
          .rejects.toMatchObject({ data: { code: "payment.stale_preview" } });
      }
      const target = { kind: "meeting" as const, meetingId: f.meetingId };
      expect(await f.closer.query(api.payments.reconcileCheck.getPaymentReconciliation, { target }))
        .toEqual({ conflicts: [], prefill: [] });
      await expect(f.closer.mutation(api.closer.payments.logPayment, f.args))
        .rejects.toMatchObject({ data: { code: "payment.proof_required" } });
      const proofFileId = await storeProofFile(f.t);
      const id = await f.closer.mutation(api.closer.payments.logPayment, { ...f.args, proofFileId });
      expect(await f.t.run((ctx) => ctx.db.get("paymentRecords", id)))
        .toMatchObject({ origin: "closer_meeting", proofFileId });
      const fact = await f.t.run((ctx) => ctx.db.get("providerPayments", f.providerPaymentId));
      expect(fact?.paymentRecordId).toBeUndefined();
      expect(fact?.excludedOpportunityIds).toEqual(reason === "an excluded deal" ? [f.opportunityId] : undefined);
      await f.invariant();
    },
  );

  it("creates provider cash with the confirmer, consumes one decision and leaves other attendance owed", async () => {
    const f = await meetingFixture();
    await f.invariant();
    const paymentId = await f.closer.mutation(api.closer.payments.logPayment, { ...f.args, provider: f.confirm });
    const state = await f.t.run(async (ctx) => ({
      payment: await ctx.db.get("paymentRecords", paymentId),
      fact: await ctx.db.get("providerPayments", f.providerPaymentId),
      decision: await ctx.db.get("resultAutomationDecisions", f.decisionId),
      deal: await ctx.db.get("opportunities", f.opportunityId),
      held: await ctx.db.get("meetings", f.meetingId),
      owed: await ctx.db.get("meetings", f.otherMeetingId),
    }));
    expect(state.payment).toMatchObject({
      origin: "provider", recordedVia: "provider", recordedByUserId: f.closerId, attributedCloserId: f.closerId,
      providerPaymentId: f.providerPaymentId, providerPaidAt: FIXTURE_PAID_AT,
      recordedAt: FIXTURE_NOW, amountMinor: 10000, currency: "USD",
      programId: f.programId, paymentType: "deposit", automationDecisionId: f.decisionId,
    });
    expect(state.payment?.proofFileId).toBeUndefined();
    expect(state.fact).toMatchObject({ reviewState: "recorded", paymentRecordId: paymentId, allocationRevision: 1 });
    expect(state.decision).toMatchObject({
      state: "applied", appliedVia: "meeting_attended", appliedPaymentRecordId: paymentId,
      resolvedByUserId: f.closerId, humanResultRevisionAfter: 1,
      before: { position: "booked", meetings: [{ meetingId: f.meetingId, status: "scheduled" }] },
    });
    expect(state.deal).toMatchObject({ outcome: "won", humanResultRevision: 1, paymentReceivedAt: FIXTURE_NOW });
    expect(state.held).toMatchObject({ status: "held", heldMarkedAt: FIXTURE_NOW });
    expect(state.held?.attendanceOwedSince).toBeUndefined();
    expect(state.owed).toMatchObject({ status: "scheduled", attendanceOwedSince: FIXTURE_NOW + 86_400_000 + 1_800_000 });
    await f.invariant();

    await expect(f.closer.mutation(api.closer.payments.logPayment, { ...f.args, provider: f.confirm }))
      .rejects.toMatchObject({ data: { code: "payment.whop_payment_found" } });
    expect((await f.t.run((ctx) => ctx.db.get("opportunities", f.opportunityId)))?.humanResultRevision).toBe(1);
    await f.invariant();
  });

  it("carries product and price names in the conflict error", async () => {
    const f = await meetingFixture();
    await expect(f.closer.mutation(api.closer.payments.logPayment, f.args))
      .rejects.toMatchObject({ data: {
        code: "payment.whop_payment_found",
        conflicts: [{
          providerPaymentId: f.providerPaymentId,
          productTitle: "Sales training",
          variantTitle: "Pay in full",
        }],
      } });
    expect(await f.t.run((ctx) => ctx.db.query("paymentRecords").take(1))).toEqual([]);
    await f.invariant();
  });

  it.each([{ amount: 99 }, { currency: "CAD" }])("refuses a Whop amount/currency mismatch %j", async (typed) => {
    const f = await meetingFixture();
    await expect(f.closer.mutation(api.closer.payments.logPayment, { ...f.args, ...typed, provider: f.confirm }))
      .rejects.toMatchObject({ data: { code: "payment.amount_mismatch" } });
    await f.invariant();
    expect(await f.t.run((ctx) => ctx.db.query("paymentRecords").take(1))).toEqual([]);
    expect((await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", f.decisionId)))?.state).toBe("ready");
  });

  it("refuses a decision from a stale policy version", async () => {
    const f = await meetingFixture();
    await f.t.run((ctx) => ctx.db.patch("resultAutomationDecisions", f.decisionId, { policyVersion: 0 }));
    await expect(f.closer.mutation(api.closer.payments.logPayment, { ...f.args, provider: f.confirm }))
      .rejects.toMatchObject({ data: { code: "payment.stale_preview" } });
    expect(await f.t.run((ctx) => ctx.db.query("paymentRecords").take(1))).toEqual([]);
    await f.invariant();
  });

  it("refuses confirmation below ask while permitting an ordinary save", async () => {
    const f = await meetingFixture();
    await f.t.run((ctx) => setPaymentFixtureModes(ctx, { ...f, winMode: "shadow" }));
    await expect(f.closer.mutation(api.closer.payments.logPayment, { ...f.args, provider: f.confirm }))
      .rejects.toMatchObject({ data: { code: "payment.kind_off" } });
    await f.invariant();
    const proofFileId = await storeProofFile(f.t);
    await f.closer.mutation(api.closer.payments.logPayment, { ...f.args, proofFileId });
    const decision = await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", f.decisionId));
    expect(decision?.state).toBe("stopped");
    await f.invariant();
  });

  it("refuses an adverse payment before recording", async () => {
    const f = await meetingFixture();
    await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, {
      adverseFencedAt: FIXTURE_NOW,
    }));
    await expect(f.closer.mutation(api.closer.payments.logPayment, { ...f.args, provider: f.confirm }))
      .rejects.toMatchObject({ data: { code: "payment.adverse" } });
    expect(await f.t.run((ctx) => ctx.db.query("paymentRecords").take(1))).toEqual([]);
    await f.invariant();
  });

  it.each([true, false])("sets the reminder completion payment ID (Whop confirmed: %s)", async (confirmed) => {
    const f = await providerPaymentFixture({
      dealPosition: "follow_up", fact: { reviewState: "needs_person" },
    });
    const opportunityId = f.dealId!;
    const { followUpId, meetingId } = await f.t.run(async (ctx) => {
      const meetingId = await insertCloserMeeting(ctx, {
        tenantId: f.tenantId, opportunityId, closerId: f.closerId, status: "held", scheduledAt: FIXTURE_PAID_AT,
      });
      await insertMeetingAggregate(ctx, meetingId);
      if (confirmed) await setPaymentFixtureModes(ctx, f);
      const followUpId = await insertTask(ctx, {
        opportunityId, type: "manual_reminder", reason: "closer_initiated",
        status: "pending", reminderScheduledAt: FIXTURE_NOW,
      });
      return { followUpId, meetingId };
    });
    const paymentId = await f.closer.mutation(api.closer.reminderOutcomes.logReminderPayment, {
      followUpId, amount: 100, currency: "USD", programId: f.programId, paymentType: "pif",
      ...(confirmed
        ? { provider: { kind: "confirm" as const, providerPaymentId: f.providerPaymentId, expectedAllocationRevision: 0 } }
        : { proofFileId: await storeProofFile(f.t) }),
    });
    const task = await f.t.run((ctx) => ctx.db.get("followUps", followUpId));
    expect(task).toMatchObject({ status: "completed", completionOutcome: "payment_received", completionPaymentId: paymentId });
    const payment = await f.t.run((ctx) => ctx.db.get("paymentRecords", paymentId));
    expect(payment?.origin).toBe(confirmed ? "provider" : "closer_reminder");
    expect(payment?.meetingId).toBe(confirmed ? undefined : meetingId);
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("keeps a side deal manual when the matcher abstains", async () => {
    const f = await providerPaymentFixture({ source: "side_deal", fact: { reviewState: "needs_person" } });
    await f.t.run((ctx) => setPaymentFixtureModes(ctx, f));
    const args = {
      opportunityId: f.dealId!, amount: 100, currency: "USD", programId: f.programId, paymentType: "pif" as const,
    };
    await expect(f.closer.mutation(api.sideDeals.logPayment.logPayment, {
      ...args, provider: { kind: "confirm", providerPaymentId: f.providerPaymentId, expectedAllocationRevision: 0 },
    })).rejects.toMatchObject({ data: { code: "payment.stale_preview" } });
    const proofFileId = await storeProofFile(f.t);
    const { paymentId } = await f.closer.mutation(api.sideDeals.logPayment.logPayment, { ...args, proofFileId });
    const payment = await f.t.run((ctx) => ctx.db.get("paymentRecords", paymentId));
    expect(payment).toMatchObject({ origin: "closer_side_deal", recordedVia: "web", recordedByUserId: f.closerId, proofFileId });
    expect(payment?.providerPaymentId).toBeUndefined();
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("protects another closer's Whop instalment while preserving manual self-credit", async () => {
    const f = await meetingFixture();
    const membershipId = "mem_instalment_owner";
    const { otherId, instalmentId, bindingId } = await f.t.run(async (ctx) => {
      const otherId = await ctx.db.insert("users", {
        tenantId: f.tenantId, workosUserId: "user_other", email: "other@example.test", role: "closer", isActive: true,
      });
      await ctx.db.patch("providerPayments", f.providerPaymentId, { membershipId });
      const anchorPaymentRecordId = await seedProviderWin(ctx, {
        ...f, approverId: f.adminId, recordedAt: FIXTURE_PAID_AT,
      });
      const bindingId = await insertProviderBinding(ctx, {
        ...f, externalId: membershipId,
        binding: { kind: "membership_deal", opportunityId: f.opportunityId, leadId: f.personId, anchorPaymentRecordId },
      });
      const instalmentId = await insertProviderFact(ctx, f.tenantId, f.connectionId, {
        externalPaymentId: "pay_instalment_owner", membershipId, billingReason: "subscription_cycle", reviewState: "needs_person",
      });
      return { otherId, instalmentId, bindingId };
    });
    const other = f.t.withIdentity({ subject: "user_other", org_id: "org_test" });
    const args = { opportunityId: f.opportunityId, amount: 100, currency: "USD", paymentType: "deposit" as const };
    const target = { kind: "deal" as const, opportunityId: f.opportunityId };
    const provider = {
      kind: "confirm" as const, providerPaymentId: instalmentId, expectedAllocationRevision: 0,
      otherPins: [{ providerPaymentId: f.providerPaymentId, allocationRevision: 1 }],
    };
    await expect(other.query(api.payments.reconcileCheck.getPaymentReconciliation, { target }))
      .rejects.toThrow("not the assigned closer");
    await expect(other.mutation(api.closer.additionalPayment.recordAdditionalPayment, { ...args, provider }))
      .rejects.toThrow("not the assigned closer");

    await f.t.run((ctx) => ctx.db.patch("paymentProviderBindings", bindingId, { enabled: false }));
    await expect(f.closer.mutation(api.closer.additionalPayment.recordAdditionalPayment, { ...args, provider }))
      .rejects.toMatchObject({ data: { code: "payment.stale_preview" } });
    await f.t.run((ctx) => ctx.db.patch("paymentProviderBindings", bindingId, { enabled: true }));
    const instalment = await f.closer.mutation(api.closer.additionalPayment.recordAdditionalPayment, { ...args, provider });
    const duplicateProofFileId = await storeProofFile(f.t);
    await expect(other.mutation(api.closer.additionalPayment.recordAdditionalPayment, {
      ...args, proofFileId: duplicateProofFileId,
    })).rejects.toHaveProperty("data", {
      code: "payment.billing_review_required",
      message: "Billing needs to check this payment first.",
    });
    const manualDealId = await f.t.run(async (ctx) => {
      const leadId = await insertProviderPerson(ctx, f.tenantId, { email: "manual-buyer@example.test" });
      return await insertProviderDeal(ctx, { ...f, leadId, source: "side_deal", assignedCloserId: f.closerId });
    });
    await f.closer.mutation(api.sideDeals.logPayment.logPayment, {
      ...args, opportunityId: manualDealId, programId: f.programId, proofFileId: await storeProofFile(f.t),
    });
    const manual = await other.mutation(api.closer.additionalPayment.recordAdditionalPayment, {
      ...args, opportunityId: manualDealId, proofFileId: await storeProofFile(f.t),
    });
    expect(await f.t.run((ctx) => Promise.all([
      ctx.db.get("paymentRecords", instalment.paymentId),
      ctx.db.get("paymentRecords", manual.paymentId),
    ]))).toMatchObject([
      { attributedCloserId: f.closerId, origin: "provider", providerPaymentId: instalmentId },
      { attributedCloserId: otherId, origin: "closer_additional" },
    ]);
    await f.invariant();
  });

  it("uses additional-payment mode and inherits the won deal's sold program", async () => {
    const f = await meetingFixture();
    const membershipId = "mem_inherit";
    const anchorId = await f.t.run((ctx) => insertProviderFact(ctx, f.tenantId, f.connectionId, {
      externalPaymentId: "pay_inherit_anchor", membershipId,
    }));
    await f.t.run(async (ctx) => {
      await setPaymentFixtureModes(ctx, { ...f, winMode: "off" });
      const anchorPaymentRecordId = await seedProviderWin(ctx, {
        ...f, providerPaymentId: anchorId, approverId: f.adminId, recordedAt: FIXTURE_PAID_AT,
      });
      await noteHumanResult(ctx, f.opportunityId, { tenantId: f.tenantId, userId: f.adminId });
      await insertProviderBinding(ctx, {
        ...f, externalId: membershipId,
        binding: { kind: "membership_deal", opportunityId: f.opportunityId, leadId: f.personId, anchorPaymentRecordId },
      });
      await ctx.db.patch("providerPayments", f.providerPaymentId, { membershipId, billingReason: "subscription_cycle" });
      await ctx.db.patch("paymentProviderBindings", f.variantBindingId, {
        binding: { kind: "variant_type", paymentType: "pif", laterPaymentType: "split" },
      });
    });
    const { paymentId } = await f.closer.mutation(api.closer.additionalPayment.recordAdditionalPayment, {
      opportunityId: f.opportunityId, amount: 100, currency: "USD", paymentType: "split",
      provider: {
        kind: "confirm", providerPaymentId: f.providerPaymentId, expectedAllocationRevision: 0,
        otherPins: [{ providerPaymentId: anchorId, allocationRevision: 1 }],
      },
    });
    const state = await f.t.run(async (ctx) => ({
      payment: await ctx.db.get("paymentRecords", paymentId),
      deal: await ctx.db.get("opportunities", f.opportunityId),
    }));
    expect(state.payment).toMatchObject({
      origin: "provider", recordedVia: "provider", programId: f.programId, paymentType: "split",
    });
    expect(state.deal?.humanResultRevision).toBe(2);
    await f.invariant();
  });
});

describe("linking a manual save to a Whop payment", () => {
  it("waives proof for matching money, keeps provenance, and emits the link event", async () => {
    const f = await meetingFixture();
    const paymentId = await f.closer.mutation(api.closer.payments.logPayment, { ...f.args, provider: f.sameMoney });
    const state = await f.t.run(async (ctx) => ({
      payment: await ctx.db.get("paymentRecords", paymentId),
      fact: await ctx.db.get("providerPayments", f.providerPaymentId),
      event: await ctx.db.query("domainEvents").withIndex("by_tenantId_and_eventType_and_occurredAt", (q) =>
        q.eq("tenantId", f.tenantId).eq("eventType", "payment.provider_linked")).unique(),
    }));
    expect(state.payment).toMatchObject({ origin: "closer_meeting", recordedVia: "web", providerPaymentId: f.providerPaymentId });
    expect(state.payment?.proofFileId).toBeUndefined();
    expect(state.fact).toMatchObject({ reviewState: "linked", matchMethod: "person", paymentRecordId: paymentId });
    expect(state.event).toMatchObject({ actorUserId: f.closerId, source: "closer", entityId: paymentId });
    expect(JSON.parse(state.event!.metadata!)).toEqual({ providerPaymentId: f.providerPaymentId, paymentRecordId: paymentId });
    await f.invariant();
  });

  it("asks again when either acknowledged amount or currency changes before saving", async () => {
    const f = await meetingFixture();
    const proofFileId = await storeProofFile(f.t);
    const acknowledgedAmounts = {
      crmAmountMinor: 11000, crmCurrency: "USD", providerTotalMinor: 10000, providerCurrency: "USD",
    };
    const legacyApproval = { ...f.sameMoney, acknowledgeAmountDifference: true };
    const provider = { ...legacyApproval, acknowledgedAmounts };
    const args = { ...f.args, amount: 110, proofFileId };
    const save = (values = args, intent = provider) =>
      f.closer.mutation(api.closer.payments.logPayment, { ...values, provider: intent });
    await expect(f.closer.mutation(api.closer.payments.logPayment, { ...args, provider: legacyApproval }))
      .rejects.toMatchObject({ data: { code: "payment.amount_mismatch" } });
    await expect(save({ ...args, amount: 120 })).rejects.toMatchObject({ data: { code: "payment.amount_mismatch" } });
    await expect(save({ ...args, currency: "CAD" })).rejects.toMatchObject({ data: { code: "payment.amount_mismatch" } });

    await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, {
      totalMinor: 100000, sourceUpdatedAt: FIXTURE_NOW,
    }));
    await expect(save()).rejects.toMatchObject({ data: {
      code: "payment.amount_mismatch", conflicts: [{ totalMinor: 100000, currency: "USD" }],
    } });
    await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, { currency: "EUR" }));
    await expect(save(args, { ...provider, acknowledgedAmounts: { ...acknowledgedAmounts, providerTotalMinor: 100000 } }))
      .rejects.toMatchObject({ data: { code: "payment.amount_mismatch", conflicts: [{ totalMinor: 100000, currency: "EUR" }] } });

    const id = await save(args, { ...provider, acknowledgedAmounts: {
      ...acknowledgedAmounts, providerTotalMinor: 100000, providerCurrency: "EUR",
    } });
    expect(await f.t.run((ctx) => ctx.db.get("paymentRecords", id)))
      .toMatchObject({ amountMinor: 11000, currency: "USD", providerPaymentId: f.providerPaymentId, proofFileId });
    await f.invariant();
  });

  it.each([{ amount: 125 }, { currency: "CAD" }])("requires acknowledgement and usual proof when the entries differ %j", async (typed) => {
    const f = await meetingFixture();
    const args = { ...f.args, ...typed, provider: f.sameMoney };
    await expect(f.closer.mutation(api.closer.payments.logPayment, args))
      .rejects.toMatchObject({ data: { code: "payment.amount_mismatch" } });
    const provider = {
      ...f.sameMoney,
      acknowledgeAmountDifference: true,
      acknowledgedAmounts: {
        crmAmountMinor: args.amount * 100, crmCurrency: args.currency,
        providerTotalMinor: 10000, providerCurrency: "USD",
      },
    };
    await expect(f.closer.mutation(api.closer.payments.logPayment, { ...args, provider }))
      .rejects.toMatchObject({ data: { code: "payment.proof_required" } });
    await f.invariant();
    const proofFileId = await storeProofFile(f.t);
    const paymentId = await f.closer.mutation(api.closer.payments.logPayment, { ...args, provider, proofFileId });
    expect(await f.t.run((ctx) => ctx.db.get("paymentRecords", paymentId))).toMatchObject({
      amountMinor: args.amount * 100, currency: args.currency, providerPaymentId: f.providerPaymentId, proofFileId,
    });
    await f.invariant();
  });
});

async function mapPayment(
  ctx: Parameters<typeof insertProviderBinding>[0],
  fields: Omit<Parameters<typeof insertProviderBinding>[1], "externalId" | "binding"> & {
    programId: Id<"tenantPrograms">;
  },
) {
  const { programId, ...connection } = fields;
  await insertProviderBinding(ctx, {
    ...connection, externalId: PRODUCT_ID, binding: { kind: "product_program", programId },
  });
  await insertProviderBinding(ctx, {
    ...connection, externalId: VARIANT_ID, binding: { kind: "variant_type", paymentType: "pif" },
  });
}

it("keeps the meeting writer's Second opinion queue on a Whop confirmation", async () => {
  const f = await secondOpinionHarness("on", "scheduled");
  const { tenantId, ownerId: adminId, opportunityId, meetingId } = f;
  const { programId, providerPaymentId } = await f.t.run(async (ctx) => {
    await insertOpportunityAggregate(ctx, opportunityId);
    await insertMeetingAggregate(ctx, meetingId);
    await setPaymentFixtureModes(ctx, { tenantId, adminId });
    const connectionId = await insertPaymentFixtureConnection(ctx, tenantId, adminId);
    const programId = await insertProgram(ctx, tenantId, "Synthetic program");
    await mapPayment(ctx, { tenantId, connectionId, adminId, programId });
    const providerPaymentId = await insertProviderFact(ctx, tenantId, connectionId, {
      payerEmail: "grace@example.com", reviewState: "needs_person", paidAt: FIXTURE_NOW,
    });
    return { programId, providerPaymentId };
  });
  const paymentId = await f.closer.mutation(api.closer.payments.logPayment, {
    opportunityId, meetingId, programId, amount: 100, currency: "USD", paymentType: "pif",
    provider: { kind: "confirm", providerPaymentId, expectedAllocationRevision: 0 },
  });
  const opinions = await f.t.run((ctx) => ctx.db.query("secondOpinions").take(2));
  expect(opinions).toMatchObject([{
    meetingId, trigger: "result_recorded", status: "queued", record: { kind: "payment", amountMinor: 10000 },
  }]);
  expect(paymentId).toBeDefined();
  await assertPaymentInvariants(f.t, { tenantId });
});

it("returns a readable MCP refusal with the web link and rolls back a provisioned upload", async () => {
  const f = await mcpToolsFixture();
  const { t, tenantId, ownerId: adminId, leadId, meetingId } = f;
  const { programId, connectionId } = await t.run(async (ctx) => {
    await setPaymentFixtureModes(ctx, { tenantId, adminId });
    await ctx.db.patch("leads", leadId, { email: PAYER_EMAIL });
    const programId = await insertMcpProgram(ctx, tenantId, adminId, "Synthetic program");
    const connectionId = await insertPaymentFixtureConnection(ctx, tenantId, adminId);
    await mapPayment(ctx, { tenantId, connectionId, adminId, programId });
    return { programId, connectionId };
  });
  const args = { meetingId, programId, amount: 100, currency: "USD", paymentType: "pif" as const };
  const caller = testCaller(f.orgId, "chatgpt");
  const preview = await t.mutation(internal.mcp.tools.payments.previewPayment, { ...args, caller, proofKind: "file" });
  await t.run((ctx) => insertProviderFact(ctx, tenantId, connectionId, { reviewState: "needs_person", paidAt: FIXTURE_NOW }));

  const storageId = await storeProofFile(t);
  await expect(t.mutation(internal.mcp.tools.payments.commitPayment, {
    ...args, caller, confirmToken: preview.confirmToken, storedFile: { storageId },
  })).rejects.toMatchObject({ data: {
    code: "payment.whop_payment_found",
    message: expect.stringContaining("/workspace/closer/pay?"),
  } });
  const tool = await callTool(t, f.token, f.sessionId, "magnus_log_payment", { ...args, confirm: false });
  expect(tool.isError).toBe(true);
  expect(tool.text).toContain("Review the Whop payment");
  expect(tool.text).toContain("/workspace/closer/pay?");
  expect(tool.text).not.toContain(PAYER_EMAIL);
  const state = await t.run(async (ctx) => ({
    paymentRows: await ctx.db.query("paymentRecords").take(1),
    uploadRows: await ctx.db.query("paymentProofUploads").take(1),
    deal: await ctx.db.get("opportunities", f.dealId),
  }));
  expect(state.paymentRows).toEqual([]);
  expect(state.uploadRows).toEqual([]);
  expect(state.deal?.humanResultRevision).toBeUndefined();
  await assertPaymentInvariants(t, { tenantId });
});
