import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertTask } from "../../tests/closerPipelineFixtures";
import { assertPaymentInvariants, seedProviderWin, seedUndoToBooked } from "../../tests/paymentInvariants";
import {
  FIXTURE_NOW, FIXTURE_PAID_AT, insertProviderBinding, insertProviderDeal, insertProviderFact, insertProviderMeeting,
  insertProviderPerson, paymentConfirmationApi, paymentConfirmationFixture, seedReadablePaymentRecording, setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { evaluateSubject } from "../automation/decisions";
import { billingPaymentsByStatus } from "../billing/aggregates";
import { opportunityByStage, paymentSums } from "../reporting/aggregates";
import { insertPaymentAggregate } from "../reporting/writeHooks";
import { storeProofFile } from "../../tests/proofFixtures";
import { findPaymentTarget } from "./match";

const confirm = paymentConfirmationApi.payments.confirm;
type Fixture = Awaited<ReturnType<typeof paymentConfirmationFixture>>;
const invariant = (f: Fixture) => assertPaymentInvariants(f.t, { tenantId: f.tenantId });
const target = (f: Fixture, providerPaymentId = f.providerPaymentId, opportunityId = f.dealId) => ({
  providerPaymentId, opportunityId,
});

async function pin(f: Fixture, selection = target(f)) {
  const { preview, decisionId } = await f.admin.query(confirm.previewWhopConfirm, selection);
  if (!preview.ok) throw new Error(preview.code);
  return {
    ...selection, decisionId, expectedFingerprint: preview.fingerprint, expectedAllocationRevision: preview.allocationRevision,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("provider apply", () => {
  it("keeps sandbox cash and evidence out of production while allowing the designated dev deployment", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "https://cautious-donkey-511.convex.cloud");
    const f = await paymentConfirmationFixture();
    const meetingId = await f.t.run((ctx) => insertProviderMeeting(ctx, {
      ...f, opportunityId: f.dealId, scheduledAt: FIXTURE_NOW - 60_000,
    }));
    const args = {
      opportunityId: f.dealId, meetingId, amount: 100, currency: "USD",
      paymentType: "pif" as const, programId: f.programId,
    };
    const approval = await pin(f);
    vi.stubEnv("CONVEX_CLOUD_URL", "https://synthetic-prod.convex.cloud");

    const visible = await f.admin.query(api.payments.review.listProviderExceptions, {
      paginationOpts: { cursor: null, numItems: 5 },
    });
    expect(visible.page).toMatchObject([{ providerPaymentId: f.providerPaymentId, environment: "sandbox" }]);
    expect((await f.admin.query(confirm.previewWhopConfirm, target(f))).preview)
      .toEqual({ ok: false, code: "sandbox_payment" });
    expect(await f.admin.mutation(confirm.confirmWhopPayment, approval)).toEqual({ ok: false, code: "sandbox_payment" });
    const intent = { providerPaymentId: f.providerPaymentId, expectedAllocationRevision: 0 };
    for (const provider of [
      { ...intent, kind: "confirm" as const },
      { ...intent, kind: "same_money" as const, acknowledgeAmountDifference: false },
    ]) {
      await expect(f.closer.mutation(api.closer.payments.logPayment, { ...args, provider }))
        .rejects.toMatchObject({ data: { code: "payment.sandbox_payment" } });
    }
    await expect(f.closer.mutation(api.closer.payments.logPayment, args))
      .rejects.toMatchObject({ data: { code: "payment.proof_required" } });
    const paymentRecordId = await f.admin.mutation(api.closer.payments.logPayment, args);
    const link = { ...intent, paymentRecordId };
    await expect(f.admin.mutation(api.payments.review.linkToPaymentRecord, link))
      .rejects.toMatchObject({ data: { code: "payment.sandbox_payment" } });
    await invariant(f);

    vi.stubEnv("CONVEX_CLOUD_URL", "https://cautious-donkey-511.convex.cloud");
    await expect(f.admin.mutation(api.payments.review.linkToPaymentRecord, link))
      .resolves.toMatchObject({ allocationRevision: 1, paymentRecordId });
    await invariant(f);
  });

  it("refuses a fresh Billing confirmation after the deal was vetoed as a wrong match", async () => {
    const f = await paymentConfirmationFixture();
    const first = await f.admin.mutation(confirm.confirmWhopPayment, await pin(f));
    if (!first.ok) throw new Error(first.code);
    await f.t.run((ctx) => seedUndoToBooked(ctx, {
      paymentRecordId: first.paymentRecordId, approverId: f.adminId, now: FIXTURE_NOW, veto: true,
    }));

    const { preview } = await f.admin.query(confirm.previewWhopConfirm, target(f));
    const result = await f.admin.mutation(confirm.confirmWhopPayment, {
      ...target(f), expectedFingerprint: preview.ok ? preview.fingerprint : "vetoed", expectedAllocationRevision: 2,
    });
    expect(result).toEqual({ ok: false, code: "binding_invalid" });
    expect(preview).toEqual(result);
    expect(await f.t.run((ctx) => ctx.db.get("providerPayments", f.providerPaymentId))).toMatchObject({
      excludedOpportunityIds: [f.dealId], allocationRevision: 2,
    });
    await invariant(f);
  });

  it("holds a late email-only payment after manual cash won another deal for the person", async () => {
    const f = await paymentConfirmationFixture({ fact: { reviewState: "not_actionable" } });
    const sideDealId = await f.t.run((ctx) => insertProviderDeal(ctx, {
      ...f, leadId: f.personId, assignedCloserId: f.closerId, source: "side_deal",
    }));
    const { paymentId: manualId } = await f.closer.mutation(api.sideDeals.logPayment.logPayment, {
      opportunityId: sideDealId, amount: 100, currency: "USD", programId: f.programId, paymentType: "pif",
      proofFileId: await storeProofFile(f.t),
    });
    await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, { reviewState: "needs_person" }));
    const match = () => f.t.run(async (ctx) => findPaymentTarget(
      ctx, (await ctx.db.get("providerPayments", f.providerPaymentId))!,
    ));
    const candidate = await match();
    const { preview } = await f.admin.query(confirm.previewWhopConfirm, target(f));
    const result = await f.admin.mutation(confirm.confirmWhopPayment, {
      ...target(f), expectedFingerprint: preview.ok ? preview.fingerprint : "held", expectedAllocationRevision: 0,
    });
    expect({ candidate, result }).toMatchObject({
      candidate: { kind: "needs_person", reason: "unlinked_manual_payment", candidateOpportunityIds: [f.dealId] },
      result: { ok: false, code: "unlinked_manual_payment" },
    });
    expect(await f.t.run((ctx) => ctx.db.get("opportunities", f.dealId))).toMatchObject({ outcome: "open" });
    await invariant(f);

    // Cash logged well before Whop collected this charge cannot be it.
    const { loggedAt, paidAt } = await f.t.run(async (ctx) => ({
      loggedAt: (await ctx.db.get("paymentRecords", manualId))!.recordedAt,
      paidAt: (await ctx.db.get("providerPayments", f.providerPaymentId))!.paidAt!,
    }));
    await f.t.run((ctx) => ctx.db.patch("paymentRecords", manualId, { recordedAt: paidAt - 2 * 86_400_000 }));
    expect(await match()).toMatchObject({ kind: "ready", opportunityId: f.dealId });
    await f.t.run((ctx) => ctx.db.patch("paymentRecords", manualId, { recordedAt: loggedAt }));
    expect(await match()).toMatchObject({ kind: "needs_person", reason: "unlinked_manual_payment" });

    await f.t.run((ctx) => ctx.db.patch("paymentRecords", manualId, {
      distinctFromProviderPaymentIds: [f.providerPaymentId],
    }));
    expect(await match()).toMatchObject({ kind: "ready", opportunityId: f.dealId });
    expect(await f.admin.mutation(confirm.confirmWhopPayment, await pin(f))).toMatchObject({ ok: true });
    await invariant(f);
  });

  it("runs the admin meeting payment's financial hooks and event order while leaving the call scheduled", async () => {
    const run = async (via: "billing" | "meeting") => {
      const f = await paymentConfirmationFixture();
      const meetingId = await f.t.run((ctx) => insertProviderMeeting(ctx, {
        ...f, opportunityId: f.dealId, scheduledAt: FIXTURE_NOW + 60_000,
      }));
      await f.t.run((ctx) => seedReadablePaymentRecording(ctx, { ...f, meetingId }));
      await invariant(f);
      let paymentId: Id<"paymentRecords">;
      if (via === "billing") {
        const applied = await f.admin.mutation(confirm.confirmWhopPayment, await pin(f));
        if (!applied.ok) throw new Error(applied.code);
        paymentId = applied.paymentRecordId;
      } else {
        paymentId = await f.admin.mutation(api.closer.payments.logPayment, {
          opportunityId: f.dealId, meetingId, amount: 100, currency: "USD", paymentType: "pif", programId: f.programId,
          provider: { kind: "confirm", providerPaymentId: f.providerPaymentId, expectedAllocationRevision: 0 },
        });
      }
      await invariant(f);
      return await f.t.run(async (ctx) => {
        const deal = (await ctx.db.get("opportunities", f.dealId))!;
        const meeting = (await ctx.db.get("meetings", meetingId))!;
        const payment = (await ctx.db.get("paymentRecords", paymentId))!;
        const events = await ctx.db.query("domainEvents").take(30);
        const enrollments = await ctx.db.query("enrollments").take(2);
        const receipt = await ctx.db.get("resultAutomationDecisions", payment.automationDecisionId!);
        const lines = await ctx.db.query("closerPinnedLines").take(2);
        expect(await ctx.db.query("secondOpinions").take(2)).toHaveLength(via === "billing" ? 0 : 1);

        expect(payment).toMatchObject({
          recordedAt: FIXTURE_NOW, providerPaidAt: FIXTURE_PAID_AT, recordedByUserId: f.adminId,
          attributedCloserId: f.closerId, origin: "provider", recordedVia: "provider",
        });
        expect(payment.proofFileId).toBeUndefined();
        expect(deal).toMatchObject({ stage: "closed", outcome: "won", humanResultRevision: 1, paymentReceivedAt: FIXTURE_NOW });
        if (via === "billing") {
          expect(meeting).toMatchObject({ status: "scheduled", attendanceOwedSince: meeting.scheduledAt + 30 * 60_000 });
          expect(meeting.heldMarkedAt).toBeUndefined();
          expect(payment.meetingId).toBeUndefined();
          expect(receipt).toMatchObject({ ruleVersion: "person_pick", appliedVia: "billing", state: "applied" });
          expect(lines).toMatchObject([{
            kind: "win_recorded_from_whop", userId: f.closerId, amountMinor: 10000, currency: "USD", decisionId: receipt?._id,
          }]);
        } else {
          expect(meeting).toMatchObject({ status: "held", heldMarkedAt: FIXTURE_NOW, soldProgramId: f.programId });
          expect(meeting.attendanceOwedSince).toBeUndefined();
        }

        const namespace = f.tenantId;
        return {
          deal: {
            stage: deal.stage, outcome: deal.outcome, paymentReceivedAt: deal.paymentReceivedAt,
            soldProgram: [deal.soldProgramId, deal.soldProgramName], updatedAt: deal.updatedAt,
          },
          payment: {
            amountMinor: payment.amountMinor, currency: payment.currency, paymentType: payment.paymentType,
            program: [payment.programId, payment.programName], status: payment.status, recordedAt: payment.recordedAt,
            statusChangedAt: payment.statusChangedAt, origin: payment.origin, recordedVia: payment.recordedVia,
          },
          enrollments: enrollments.map(({ createdAt, enrolledAt, leadId, opportunityId, programId, status }) =>
            ({ createdAt, enrolledAt, leadId, opportunityId, programId, status })),
          aggregates: [
            await paymentSums.count(ctx, { namespace }), await paymentSums.sum(ctx, { namespace }),
            await billingPaymentsByStatus.count(ctx, { namespace }), await billingPaymentsByStatus.sum(ctx, { namespace }),
            await opportunityByStage.count(ctx, { namespace, bounds: { prefix: ["closed", "won", f.closerId] } }),
          ],
          events: events.map(({ eventType, occurredAt, source, fromStatus, toStatus, actorUserId, metadata }) => {
            const fields = JSON.parse(metadata ?? "{}");
            delete fields.paymentId;
            delete fields.meetingId;
            delete fields.providerPaymentId;
            return { eventType, occurredAt, source, fromStatus, toStatus, actorUserId, fields };
          }),
        };
      });
    };

    const billing = await run("billing");
    const meeting = await run("meeting");
    expect(billing.aggregates.slice(0, 2)).toEqual([1, 10000]);
    expect(billing.events.map((event) => event.eventType)).toEqual([
      "lead.lifecycle_stage_changed", "opportunity.stage_changed", "payment.recorded", "enrollment.created", "lead.status_changed",
    ]);
    expect(billing).toEqual(meeting);
  });

  it.each(["closer_initiated", "no_show_follow_up"] as const)("wins a Follow-up deal and expires its %s link", async (reason) => {
    const f = await paymentConfirmationFixture({ dealPosition: "follow_up" });
    const followUpId = await f.t.run((ctx) => insertTask(ctx, {
      opportunityId: f.dealId, type: "scheduling_link", reason, status: "pending",
    }));
    await invariant(f);
    const args = await pin(f);
    const applied = await f.admin.mutation(confirm.confirmWhopPayment, args);
    if (!applied.ok) throw new Error(applied.code);
    const snapshot = await f.t.run(async (ctx) => ({
      followUp: await ctx.db.get("followUps", followUpId),
      receipt: await ctx.db.get("resultAutomationDecisions", applied.decisionId),
      events: await ctx.db.query("domainEvents").take(15),
    }));
    expect(snapshot.followUp?.status).toBe("expired");
    expect(snapshot.receipt?.before?.tasks).toEqual([{ followUpId, status: "pending" }]);
    expect(snapshot.events.map((event) => event.eventType).slice(1, 4))
      .toEqual(["opportunity.stage_changed", "followUp.expired", "payment.recorded"]);
    expect(JSON.parse(snapshot.events[2].metadata ?? "{}")).toMatchObject({ code: "deal_paid" });
    await invariant(f);
  });

  it.each(["no_show", "canceled", "stale"] as const)("lets a person choose a deal closed by the system for %s", async (lostReason) => {
    const f = await paymentConfirmationFixture({ dealPosition: "lost", lostReason });
    const lostAt = FIXTURE_NOW - 60_000;
    const booking = await f.t.run(async (ctx) => {
      await ctx.db.patch("opportunities", f.dealId, { lostAt });
      return await insertProviderMeeting(ctx, {
        ...f, opportunityId: f.dealId, status: lostReason === "no_show" ? "no_show" : "canceled",
        scheduledAt: FIXTURE_NOW - 2 * 60_000,
      });
    });
    const beforeMeeting = await f.t.run((ctx) => ctx.db.get("meetings", booking));
    await invariant(f);
    const applied = await f.admin.mutation(confirm.confirmWhopPayment, await pin(f));
    if (!applied.ok) throw new Error(applied.code);
    await invariant(f);
    const snapshot = await f.t.run(async (ctx) => ({
      deal: await ctx.db.get("opportunities", f.dealId),
      meeting: await ctx.db.get("meetings", booking),
      receipt: await ctx.db.get("resultAutomationDecisions", applied.decisionId),
    }));
    expect(snapshot.deal?.lostReason).toBeUndefined();
    expect(snapshot.deal?.lostAt).toBeUndefined();
    expect(snapshot.meeting).toEqual(beforeMeeting);
    expect(snapshot.receipt?.before).toMatchObject({ position: "system_loss", systemLossReason: lostReason, lostAt });
  });

  it.each([true, false])("records a later payment without a second win, membership binding = %s", async (bound) => {
    const f = await paymentConfirmationFixture({ fact: { membershipId: "membership_fixture" } });
    const firstRecordedAt = FIXTURE_NOW - 5_000;
    const anchorId = await f.t.run((ctx) => seedProviderWin(ctx, {
      ...f, opportunityId: f.dealId, approverId: f.adminId, recordedAt: firstRecordedAt,
    }));
    await invariant(f);
    const payment = await f.t.run(async (ctx) => {
      if (bound) {
        await insertProviderBinding(ctx, {
          ...f, externalId: "membership_fixture",
          binding: { kind: "membership_deal", opportunityId: f.dealId, leadId: f.personId, anchorPaymentRecordId: anchorId },
        });
      }
      return await insertProviderFact(ctx, f.tenantId, f.connectionId, {
        externalPaymentId: "pay_instalment", reviewState: "needs_person",
        membershipId: bound ? "membership_fixture" : undefined, billingReason: bound ? "subscription_cycle" : "one_time",
      });
    });
    await invariant(f);
    if (bound) {
      const result = await f.t.run((ctx) => evaluateSubject(ctx, {
        tenantId: f.tenantId, providerPaymentId: payment, now: FIXTURE_NOW, cause: "sweep",
      }));
      expect(result.decisionId).toBeTruthy();
      await invariant(f);
    }
    const args = await pin(f, target(f, payment));
    expect(Boolean(args.decisionId)).toBe(bound);
    const installed = await f.admin.mutation(confirm.confirmWhopPayment, args);
    if (!installed.ok) throw new Error(installed.code);
    expect(await f.t.run((ctx) => ctx.db.get("opportunities", f.dealId)))
      .toMatchObject({ outcome: "won", paymentReceivedAt: firstRecordedAt, soldProgramId: f.programId, latestActivityAt: FIXTURE_NOW });
    expect(await f.closer.query(paymentConfirmationApi.closer.pinnedLines.listMyPinnedLines, {}))
      .toMatchObject([{ kind: "instalment_credited", amountMinor: 10000, currency: "USD" }]);
    await invariant(f);
  });

  it.each(["Billing", "closer"] as const)("records a won side deal's confirmed membership renewal through %s", async (writer) => {
    const membershipId = "mem_side_deal_renewal";
    const f = await paymentConfirmationFixture({ source: "side_deal", fact: { membershipId } });
    const firstRecordedAt = FIXTURE_NOW - 5_000;
    vi.setSystemTime(firstRecordedAt);
    const { paymentId: anchorId } = await f.closer.mutation(api.sideDeals.logPayment.logPayment, {
      opportunityId: f.dealId, amount: 100, currency: "USD", programId: f.programId, paymentType: "pif",
      proofFileId: await storeProofFile(f.t),
    });
    await f.admin.mutation(api.payments.review.linkToPaymentRecord, {
      providerPaymentId: f.providerPaymentId, paymentRecordId: anchorId, expectedAllocationRevision: 0,
    });
    await f.admin.mutation(api.payments.bindings.confirmMembership, {
      providerPaymentId: f.providerPaymentId, expectedMembershipId: membershipId,
      expectedAllocationRevision: 1, expectedBindingVersion: 0,
    });

    vi.setSystemTime(FIXTURE_NOW);
    const renewal = await f.t.run(async (ctx) => {
      const providerPaymentId = await insertProviderFact(ctx, f.tenantId, f.connectionId, {
        externalPaymentId: "pay_side_deal_renewal", reviewState: "needs_person",
        membershipId, billingReason: "subscription_cycle", paidAt: FIXTURE_NOW, totalMinor: 5000,
      });
      const { decisionId } = await evaluateSubject(ctx, {
        tenantId: f.tenantId, providerPaymentId, now: FIXTURE_NOW, cause: "sweep",
      });
      const decision = decisionId && await ctx.db.get("resultAutomationDecisions", decisionId);
      return { providerPaymentId, decision };
    });
    expect(renewal.decision).toMatchObject({
      kind: "additional_payment", state: "ready", wouldWrite: true, automaticEligible: true,
    });

    let paymentRecordId: Id<"paymentRecords">;
    const selection = target(f, renewal.providerPaymentId);
    if (writer === "Billing") {
      const args = await pin(f, selection);
      expect(args.decisionId).toBe(renewal.decision?._id);
      const result = await f.admin.mutation(confirm.confirmWhopPayment, args);
      if (!result.ok) throw new Error(result.code);
      paymentRecordId = result.paymentRecordId;
    } else {
      const reconciliation = await f.closer.query(api.payments.reconcileCheck.getPaymentReconciliation, {
        target: { kind: "deal", opportunityId: f.dealId },
      });
      expect(reconciliation.conflicts).toMatchObject([{ providerPaymentId: renewal.providerPaymentId, state: "unlinked" }]);
      const result = await f.closer.mutation(api.closer.additionalPayment.recordAdditionalPayment, {
        opportunityId: f.dealId, amount: 50, currency: "USD", paymentType: "pif",
        provider: {
          kind: "same_money", providerPaymentId: renewal.providerPaymentId,
          expectedAllocationRevision: 0, acknowledgeAmountDifference: false,
        },
      });
      paymentRecordId = result.paymentId;
    }
    const state = await f.t.run(async (ctx) => ({
      deal: await ctx.db.get("opportunities", f.dealId),
      row: await ctx.db.get("paymentRecords", paymentRecordId),
      fact: await ctx.db.get("providerPayments", renewal.providerPaymentId),
    }));
    expect(state.deal).toMatchObject({ outcome: "won", paymentReceivedAt: firstRecordedAt });
    expect(state.row).toMatchObject({
      origin: writer === "Billing" ? "provider" : "closer_additional",
      programId: f.programId, amountMinor: 5000, providerPaymentId: renewal.providerPaymentId,
    });
    expect(state.row?.proofFileId).toBeUndefined();
    expect(state.fact).toMatchObject({ paymentRecordId, allocationRevision: 1 });
    await invariant(f);
  });

  it.each(["side_deal", "qualified_only", "lost_by_person"] as const)("refuses %s before writing", async (code) => {
    const f = await paymentConfirmationFixture(code === "side_deal" ? { source: "side_deal" } :
      { dealPosition: code === "qualified_only" ? "qualified" : "lost" });
    if (code === "lost_by_person") {
      await f.t.run((ctx) => ctx.db.patch("opportunities", f.dealId, { lostByUserId: f.adminId, lostReason: "Budget" }));
    }
    await invariant(f);
    const result = await f.admin.query(confirm.previewWhopConfirm, target(f));
    expect(result.preview).toEqual({ ok: false, code });
    expect(await f.admin.mutation(confirm.confirmWhopPayment, {
      ...target(f), expectedFingerprint: "", expectedAllocationRevision: 0,
    })).toEqual({ ok: false, code });
    await invariant(f);
  });

  it("requires choices for unmapped money and refuses a stale fingerprint, revision or disabled kind", async () => {
    const f = await paymentConfirmationFixture({ fact: { productId: "unknown", variantId: "unknown", payerEmail: "buyer@example.com" } });
    await invariant(f);
    const original = await pin(f);
    expect(await f.admin.mutation(confirm.confirmWhopPayment, original)).toEqual({ ok: false, code: "program_required" });
    await invariant(f);
    await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, { allocationRevision: 1 }));
    expect(await f.admin.mutation(confirm.confirmWhopPayment, original)).toEqual({ ok: false, code: "stale_preview" });
    await invariant(f);
    const fresh = await pin(f);
    await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, { totalMinor: 12000 }));
    const choices = { programId: f.programId, paymentType: "pif" as const };
    expect(await f.admin.mutation(confirm.confirmWhopPayment, { ...fresh, ...choices })).toEqual({ ok: false, code: "stale_preview" });
    await invariant(f);
    const latest = await pin(f);
    await f.t.run((ctx) => setPaymentFixtureModes(ctx, { ...f, winMode: "shadow" }));
    expect(await f.admin.mutation(confirm.confirmWhopPayment, { ...latest, ...choices })).toEqual({ ok: false, code: "kind_off" });
    await invariant(f);
    await f.t.run((ctx) => setPaymentFixtureModes(ctx, f));
    expect(await f.admin.mutation(confirm.confirmWhopPayment, { ...await pin(f), ...choices })).toMatchObject({ ok: true });
    await invariant(f);
  });

  it("asks only for the payment type when the product is mapped and the price is not", async () => {
    const f = await paymentConfirmationFixture({ fact: { variantId: "unknown", payerEmail: "buyer@example.com" } });
    await invariant(f);
    expect(await f.admin.mutation(confirm.confirmWhopPayment, await pin(f))).toEqual({ ok: false, code: "program_required" });
    expect(await f.admin.mutation(confirm.confirmWhopPayment, { ...await pin(f), paymentType: "pif" }))
      .toMatchObject({ ok: true });
    await invariant(f);
  });

  it("rechecks the target and an adverse fence at commit, and leaves both deals open on refusal", async () => {
    const f = await paymentConfirmationFixture();
    const anotherDeal = await f.t.run(async (ctx) => insertProviderDeal(ctx, {
      ...f, assignedCloserId: f.closerId, leadId: await insertProviderPerson(ctx, f.tenantId, { email: "new-payer@example.com" }),
    }));
    await invariant(f);
    const original = await pin(f);
    await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, { payerEmail: "new-payer@example.com" }));
    expect(await f.admin.mutation(confirm.confirmWhopPayment, original)).toEqual({ ok: false, code: "binding_invalid" });
    await invariant(f);
    const fresh = await pin(f, target(f, f.providerPaymentId, anotherDeal));
    await f.t.run((ctx) => ctx.db.patch("providerPayments", f.providerPaymentId, { adverseFencedAt: FIXTURE_NOW }));
    expect(await f.admin.mutation(confirm.confirmWhopPayment, fresh)).toEqual({ ok: false, code: "adverse" });
    await invariant(f);
    expect(await f.t.run((ctx) => ctx.db.query("paymentRecords").take(1))).toEqual([]);
  });

  it.each([false, true])("adds the 40th stored row and holds the next, after rematch = %s", async (rematch) => {
    const f = await paymentConfirmationFixture();
    let opportunityId = f.dealId;
    if (rematch) {
      const oldPaymentId = await f.t.run((ctx) => seedProviderWin(ctx, {
        ...f, opportunityId, approverId: f.adminId, recordedAt: FIXTURE_NOW - 5_000,
      }));
      await invariant(f);
      await f.t.run((ctx) => seedUndoToBooked(ctx, {
        paymentRecordId: oldPaymentId, veto: true, approverId: f.adminId, now: FIXTURE_NOW - 4_000,
      }));
      await invariant(f);
      opportunityId = await f.t.run(async (ctx) => insertProviderDeal(ctx, {
        ...f, assignedCloserId: f.closerId, leadId: await insertProviderPerson(ctx, f.tenantId, { email: "different@example.com" }),
      }));
      await invariant(f);
    }
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 39; i++) {
        const paymentId = await ctx.db.insert("paymentRecords", {
          tenantId: f.tenantId, opportunityId, recordedByUserId: f.adminId, attributedCloserId: f.closerId,
          amountMinor: 100, currency: "USD", programId: f.programId, programName: "Sales training",
          paymentType: "pif", recordedAt: FIXTURE_NOW - 100 - i, statusChangedAt: FIXTURE_NOW,
          origin: "admin_meeting", status: "disputed",
        });
        await insertPaymentAggregate(ctx, paymentId);
      }
    });
    await invariant(f);
    const applied = await f.admin.mutation(confirm.confirmWhopPayment, await pin(f, target(f, f.providerPaymentId, opportunityId)));
    expect(applied).toMatchObject({ ok: true });
    await invariant(f);
    const another = await f.t.run((ctx) => insertProviderFact(ctx, f.tenantId, f.connectionId, {
      externalPaymentId: "pay_next", reviewState: "needs_person",
    }));
    await invariant(f);
    const nextTarget = target(f, another, opportunityId);
    expect((await f.admin.query(confirm.previewWhopConfirm, nextTarget)).preview).toEqual({ ok: false, code: "capacity_hold" });
    expect(await f.admin.mutation(confirm.confirmWhopPayment, {
      ...nextTarget, expectedFingerprint: "old", expectedAllocationRevision: 0,
    })).toEqual({ ok: false, code: "capacity_hold" });
    await invariant(f);
  });
});
