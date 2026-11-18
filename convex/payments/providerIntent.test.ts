import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { insertCloserMeeting, insertTask } from "../../tests/closerPipelineFixtures";
import { insertProgram } from "../../tests/enrollmentFixtures";
import { insertProgram as insertMcpProgram } from "../../tests/closerPipelineDeskFixtures";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import {
  FIXTURE_NOW,
  FIXTURE_PAID_AT,
  insertPaymentFixtureConnection,
  insertProviderFact,
  PAYER_EMAIL,
  providerPaymentFixture,
  seedReadyDecision,
  setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";
import { storeProofFile } from "../../tests/proofFixtures";
import { secondOpinionHarness } from "../../tests/secondOpinionHarness";
import { callTool, testCaller } from "../../tests/mcpHarness";
import { mcpToolsFixture } from "../../tests/mcpToolsFixtures";
import { insertMeetingAggregate, insertOpportunityAggregate } from "../reporting/writeHooks";

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
    const decisionId = await seedReadyDecision(ctx, {
      tenantId, providerPaymentId, opportunityId, meetingId, leadId: f.personId, confirmRoute: "meeting",
    });
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

  it("supports confirmation through the side-deal writer", async () => {
    const f = await providerPaymentFixture({ source: "side_deal", fact: { reviewState: "needs_person" } });
    await f.t.run((ctx) => setPaymentFixtureModes(ctx, f));
    const { paymentId } = await f.closer.mutation(api.sideDeals.logPayment.logPayment, {
      opportunityId: f.dealId!, amount: 100, currency: "USD", programId: f.programId, paymentType: "pif",
      provider: { kind: "confirm", providerPaymentId: f.providerPaymentId, expectedAllocationRevision: 0 },
    });
    const payment = await f.t.run((ctx) => ctx.db.get("paymentRecords", paymentId));
    expect(payment).toMatchObject({ origin: "provider", recordedVia: "provider", recordedByUserId: f.closerId });
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  });

  it("uses additional-payment mode and inherits the won deal's sold program", async () => {
    const f = await meetingFixture();
    await f.t.run((ctx) => setPaymentFixtureModes(ctx, { ...f, winMode: "off" }));
    await f.admin.mutation(api.closer.payments.logPayment, f.args);
    const { paymentId } = await f.closer.mutation(api.closer.additionalPayment.recordAdditionalPayment, {
      opportunityId: f.opportunityId, amount: 100, currency: "USD", paymentType: "split",
      provider: { kind: "confirm", providerPaymentId: f.providerPaymentId, expectedAllocationRevision: 0 },
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

  it.each([{ amount: 125 }, { currency: "CAD" }])("requires acknowledgement and usual proof when the entries differ %j", async (typed) => {
    const f = await meetingFixture();
    const args = { ...f.args, ...typed, provider: f.sameMoney };
    await expect(f.closer.mutation(api.closer.payments.logPayment, args))
      .rejects.toMatchObject({ data: { code: "payment.amount_mismatch" } });
    const provider = { ...f.sameMoney, acknowledgeAmountDifference: true };
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

it("keeps the meeting writer's Second opinion queue on a Whop confirmation", async () => {
  const f = await secondOpinionHarness("on", "scheduled");
  const { tenantId, ownerId: adminId, opportunityId, meetingId } = f;
  const { programId, providerPaymentId } = await f.t.run(async (ctx) => {
    await insertOpportunityAggregate(ctx, opportunityId);
    await insertMeetingAggregate(ctx, meetingId);
    await setPaymentFixtureModes(ctx, { tenantId, adminId });
    const connectionId = await insertPaymentFixtureConnection(ctx, tenantId, adminId);
    return {
      programId: await insertProgram(ctx, tenantId, "Synthetic program"),
      providerPaymentId: await insertProviderFact(ctx, tenantId, connectionId, {
        payerEmail: "grace@example.com", reviewState: "needs_person",
      }),
    };
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
    return {
      programId: await insertMcpProgram(ctx, tenantId, adminId, "Synthetic program"),
      connectionId: await insertPaymentFixtureConnection(ctx, tenantId, adminId),
    };
  });
  const args = { meetingId, programId, amount: 100, currency: "USD", paymentType: "pif" as const };
  const caller = testCaller(f.orgId, "chatgpt");
  const preview = await t.mutation(internal.mcp.tools.payments.previewPayment, { ...args, caller, proofKind: "file" });
  await t.run((ctx) => insertProviderFact(ctx, tenantId, connectionId, { reviewState: "needs_person" }));

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
