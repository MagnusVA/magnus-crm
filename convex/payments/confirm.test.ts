import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { businessDayRange } from "../../lib/businessDay";
import { insertTask } from "../../tests/closerPipelineFixtures";
import { insertProgram } from "../../tests/enrollmentFixtures";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import { FIXTURE_NOW, FIXTURE_PAID_AT, PRODUCT_ID, insertProviderMeeting, paymentConfirmationApi, paymentConfirmationFixture, seedReadablePaymentRecording } from "../../tests/providerPaymentFixtures";
import { api } from "../_generated/api";
import { evaluateSubject } from "../automation/decisions";

const confirm = paymentConfirmationApi.payments.confirm;
type Fixture = Awaited<ReturnType<typeof paymentConfirmationFixture>>;
const invariant = (f: Fixture) => assertPaymentInvariants(f.t, { tenantId: f.tenantId });
const evaluate = (f: Fixture) => f.t.run((ctx) => evaluateSubject(ctx, {
  tenantId: f.tenantId, providerPaymentId: f.providerPaymentId, now: Date.now(), cause: "sweep",
}));
const preview = (f: Fixture) => f.admin.query(confirm.previewWhopConfirm, {
  providerPaymentId: f.providerPaymentId, opportunityId: f.dealId,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("confirmWhopPayment", () => {
  it("lets Billing take over an ask after the length of the tenant's business day, even if the caller omits the decision id", async () => {
    const f = await paymentConfirmationFixture();
    const setting = { timeZone: "America/Tegucigalpa", dayStartHour: 8 };
    const meetingId = await f.t.run(async (ctx) => {
      await ctx.db.patch("tenants", f.tenantId, { businessDay: setting });
      return await insertProviderMeeting(ctx, { ...f, opportunityId: f.dealId, scheduledAt: FIXTURE_NOW - 60_000 });
    });
    await invariant(f);
    const decision = await evaluate(f);
    expect(decision.decisionId).toBeTruthy();
    await invariant(f);
    const result = await preview(f);
    expect(result.attendanceOwedMeetingIds).toEqual([meetingId]);
    expect(result.attendanceOwedMeetings).toEqual([{ meetingId, scheduledAt: FIXTURE_NOW - 60_000 }]);
    const { start, end } = businessDayRange("2026-11-17", setting);
    const deadline = FIXTURE_NOW + (end - start);
    expect(result.waiting).toMatchObject({ waitsOn: "closer", closerId: f.closerId, billingAvailableAt: deadline, ageMs: 0 });
    const list = await f.admin.query(api.payments.review.listProviderExceptions, { paginationOpts: { cursor: null, numItems: 5 } });
    expect(list.page[0]).toMatchObject({ waitsOn: "closer", closerId: f.closerId, waitingSince: FIXTURE_NOW });
    if (!result.preview.ok) throw new Error("Expected a confirmation preview");
    const args = {
      providerPaymentId: f.providerPaymentId, opportunityId: f.dealId,
      expectedFingerprint: result.preview.fingerprint, expectedAllocationRevision: result.preview.allocationRevision,
    };
    vi.setSystemTime(deadline - 1);
    expect(await f.admin.mutation(confirm.confirmWhopPayment, args)).toEqual({ ok: false, code: "not_owner" });
    await invariant(f);
    vi.setSystemTime(deadline);
    expect((await preview(f)).waiting).toMatchObject({ waitsOn: "billing", ageMs: deadline - FIXTURE_NOW });
    const applied = await f.admin.mutation(confirm.confirmWhopPayment, args);
    expect(applied).toMatchObject({ ok: true, alreadyApplied: false, decisionId: decision.decisionId });
    await invariant(f);
    expect(await f.admin.mutation(confirm.confirmWhopPayment, args)).toEqual({ ...applied, alreadyApplied: true });
    await invariant(f);
  });

  it("accepts a new attended Whop ask after resuming and leaves the earlier charge stood down", async () => {
    const f = await paymentConfirmationFixture();
    const meetingId = await f.t.run((ctx) => insertProviderMeeting(ctx, {
      ...f, opportunityId: f.dealId, scheduledAt: FIXTURE_NOW - 60_000,
    }));
    const target = { kind: "meeting" as const, meetingId };
    const oldDecision = await evaluate(f);
    expect(oldDecision.decisionId).toBeTruthy();
    await f.admin.mutation(api.automation.settings.setEnabled, { enabled: false });
    await f.owner.mutation(api.automation.settings.setEnabled, { enabled: true });
    expect(await f.closer.query(confirm.getWhopAsk, { target })).toBeNull();
    expect(await f.closer.query(api.payments.reconcileCheck.getPaymentReconciliation, { target }))
      .toEqual({ conflicts: [], prefill: [] });

    vi.setSystemTime(FIXTURE_NOW + 5_000);
    const providerPaymentId = await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...fact } = (await ctx.db.get("providerPayments", f.providerPaymentId))!;
      return ctx.db.insert("providerPayments", {
        ...fact, externalPaymentId: "pay_post_resume", paidAt: Date.now(), sourceUpdatedAt: Date.now(),
      });
    });
    await evaluate({ ...f, providerPaymentId });
    const ask = await f.closer.query(confirm.getWhopAsk, { target });
    expect(ask).toMatchObject({ providerPaymentId, preview: { ok: true } });
    const args = {
      opportunityId: f.dealId, meetingId, amount: 100, currency: "USD",
      paymentType: "pif" as const, programId: f.programId,
    };
    const paymentRecordId = await f.closer.mutation(api.closer.payments.logPayment, {
      ...args, provider: {
        kind: "confirm", providerPaymentId, decisionId: ask!.decisionId, expectedAllocationRevision: 0,
      },
    });
    expect(await f.t.run((ctx) => ctx.db.get("paymentRecords", paymentRecordId)))
      .toMatchObject({ providerPaymentId, automationDecisionId: ask!.decisionId });
    expect((await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", oldDecision.decisionId!)))?.state)
      .toBe("stopped");
    await invariant(f);
  });

  it.each(["meeting", "reminder"] as const)("refuses a %s ask after the product mapping changes before save", async (route) => {
    const f = await paymentConfirmationFixture({ dealPosition: route === "meeting" ? "booked" : "follow_up" });
    const target = await f.t.run(async (ctx) => route === "meeting"
      ? { kind: route, meetingId: await insertProviderMeeting(ctx, {
        ...f, opportunityId: f.dealId, scheduledAt: FIXTURE_NOW - 60_000,
      }) }
      : { kind: route, followUpId: await insertTask(ctx, {
        opportunityId: f.dealId, type: "manual_reminder", reason: "closer_initiated",
        status: "pending", reminderScheduledAt: FIXTURE_NOW,
      }) });
    await evaluate(f);
    const ask = await f.closer.query(confirm.getWhopAsk, { target });
    expect(ask).toMatchObject({ preview: { ok: true, proposal: { programId: f.programId } } });
    const programId = await f.t.run((ctx) => insertProgram(ctx, f.tenantId, "Synthetic replacement program"));
    await f.admin.mutation(api.payments.bindings.setProductProgram, {
      connectionId: f.connectionId, productId: PRODUCT_ID, programId,
    });
    const save = (id: typeof programId, decisionId = ask!.decisionId) => {
      const args = {
        programId: id, paymentType: "pif" as const, amount: 100, currency: "USD",
        provider: {
          kind: "confirm" as const, providerPaymentId: f.providerPaymentId, expectedAllocationRevision: 0, decisionId,
        },
      };
      return target.kind === "meeting"
        ? f.closer.mutation(api.closer.payments.logPayment, { ...args, opportunityId: f.dealId, meetingId: target.meetingId })
        : f.closer.mutation(api.closer.reminderOutcomes.logReminderPayment, { ...args, followUpId: target.followUpId });
    };
    expect((await f.t.run((ctx) => ctx.db.get("resultAutomationDecisions", ask!.decisionId)))?.state).toBe("ready");
    // Even a payload whose fields match the new binding can't consume the old ask.
    await expect(save(programId)).rejects.toMatchObject({ data: { code: "payment.stale_preview" } });
    await expect(save(f.programId)).rejects.toMatchObject({ data: { code: "payment.stale_preview" } });
    expect(await f.t.run((ctx) => ctx.db.query("paymentRecords").take(1))).toEqual([]);
    await invariant(f);

    await evaluate(f);
    const updated = await f.closer.query(confirm.getWhopAsk, { target });
    expect(updated).toMatchObject({ preview: { ok: true, proposal: { programId } } });
    const paymentId = await save(programId, updated!.decisionId);
    expect(await f.t.run((ctx) => ctx.db.get("paymentRecords", paymentId))).toMatchObject({ programId });
    await invariant(f);
  });

  it.each(["meeting", "reminder"] as const)("requires the live %s even without a decision ID", async (route) => {
    const f = await paymentConfirmationFixture({ dealPosition: route === "meeting" ? "booked" : "follow_up" });
    const [first, second] = await f.t.run(async (ctx) => {
      if (route === "meeting") {
        const meeting = (scheduledAt: number) => insertProviderMeeting(ctx, {
          ...f, opportunityId: f.dealId, scheduledAt,
        });
        return [
          { kind: route, meetingId: await meeting(FIXTURE_NOW - 120_000) },
          { kind: route, meetingId: await meeting(FIXTURE_NOW - 60_000) },
        ];
      }
      const reminder = () => insertTask(ctx, {
        opportunityId: f.dealId, type: "manual_reminder", reason: "closer_initiated",
        status: "pending", reminderScheduledAt: FIXTURE_NOW,
      });
      const ids = [await reminder(), await reminder()].sort((a, b) => a.localeCompare(b));
      return ids.map((followUpId) => ({ kind: route, followUpId }));
    });
    const { decisionId } = await evaluate(f);
    if (!decisionId) throw new Error("Expected a ready Whop decision");
    const args = {
      programId: f.programId, paymentType: "pif" as const, amount: 100, currency: "USD",
    };
    const provider = { kind: "confirm" as const, providerPaymentId: f.providerPaymentId, expectedAllocationRevision: 0 };
    const save = (target: typeof first, intent: typeof provider & { decisionId?: typeof decisionId }) =>
      target.kind === "meeting"
        ? f.closer.mutation(api.closer.payments.logPayment, {
          ...args, provider: intent, opportunityId: f.dealId, meetingId: target.meetingId,
        })
        : f.closer.mutation(api.closer.reminderOutcomes.logReminderPayment, {
          ...args, provider: intent, followUpId: target.followUpId,
        });

    await expect(save(second, { ...provider, decisionId })).rejects.toMatchObject({ data: { code: "payment.stale_preview" } });
    await expect(save(second, provider)).rejects.toMatchObject({ data: { code: "payment.stale_preview" } });
    expect(await f.t.run((ctx) => ctx.db.query("paymentRecords").take(1))).toEqual([]);

    const paymentRecordId = await save(first, provider);
    expect(await f.t.run((ctx) => ctx.db.get("providerPayments", f.providerPaymentId))).toMatchObject({ paymentRecordId });
    await invariant(f);
  });

  it("routes the closer's own reminder to the reminder writer and completes it with the payment", async () => {
    const f = await paymentConfirmationFixture({ dealPosition: "follow_up" });
    const followUpId = await f.t.run((ctx) => insertTask(ctx, {
      opportunityId: f.dealId, type: "manual_reminder", reason: "closer_initiated",
      status: "pending", reminderScheduledAt: FIXTURE_NOW,
    }));
    await invariant(f);
    const { decisionId } = await evaluate(f);
    await invariant(f);
    const ask = await f.closer.query(confirm.getWhopAsk, { target: { kind: "reminder", followUpId } });
    expect(ask).toMatchObject({
      decisionId, providerPaymentId: f.providerPaymentId, createdAt: FIXTURE_NOW, paidAt: FIXTURE_PAID_AT,
      productTitle: "Sales training", variantTitle: "Pay in full",
    });
    if (!ask?.preview.ok) throw new Error("Expected a reminder preview");
    const args = {
      providerPaymentId: f.providerPaymentId, opportunityId: f.dealId, decisionId: ask.decisionId,
      expectedFingerprint: ask.preview.fingerprint, expectedAllocationRevision: ask.preview.allocationRevision,
    };
    expect(await f.admin.mutation(confirm.confirmWhopPayment, args)).toEqual({ ok: false, code: "not_owner" });
    await invariant(f);
    const paymentId = await f.closer.mutation(api.closer.reminderOutcomes.logReminderPayment, {
      followUpId, amount: 100, currency: "USD", programId: f.programId, paymentType: "pif",
      provider: { kind: "confirm", providerPaymentId: f.providerPaymentId, decisionId: ask.decisionId, expectedAllocationRevision: 0 },
    });
    expect(await f.t.run((ctx) => ctx.db.get("followUps", followUpId))).toMatchObject({
      status: "completed", completionOutcome: "payment_received", completionPaymentId: paymentId,
    });
    await invariant(f);
  });
});

describe("confirmWhopPaymentNoShow", () => {
  it("commits cash and no-show together, with one human revision and no Second opinion", async () => {
    const f = await paymentConfirmationFixture();
    const meetingId = await f.t.run((ctx) => insertProviderMeeting(ctx, {
      ...f, opportunityId: f.dealId, scheduledAt: FIXTURE_NOW - 40 * 60_000,
    }));
    await invariant(f);
    await f.t.run((ctx) => seedReadablePaymentRecording(ctx, { ...f, meetingId }));
    const { decisionId } = await evaluate(f);
    await invariant(f);
    const ask = await f.closer.query(confirm.getWhopAsk, { target: { kind: "meeting", meetingId } });
    expect(ask).toMatchObject({ decisionId, providerPaymentId: f.providerPaymentId });
    if (!ask?.preview.ok) throw new Error("Expected a meeting preview");
    const args = {
      meetingId, providerPaymentId: f.providerPaymentId, decisionId: ask.decisionId,
      amountMinor: 10000, currency: "USD", programId: f.programId, paymentType: "pif" as const,
      noShowReason: "no_response" as const, expectedFingerprint: ask.preview.fingerprint,
      expectedAllocationRevision: ask.preview.allocationRevision,
    };
    for (const mismatch of [{ amountMinor: 10100 }, { currency: "CAD" }]) {
      expect(await f.closer.mutation(confirm.confirmWhopPaymentNoShow, { ...args, ...mismatch }))
        .toEqual({ ok: false, code: "amount_mismatch" });
      await invariant(f);
    }
    vi.setSystemTime(FIXTURE_NOW - 41 * 60_000);
    expect(await f.admin.mutation(confirm.confirmWhopPaymentNoShow, args)).toEqual({ ok: false, code: "meeting_not_started" });
    await invariant(f);
    vi.setSystemTime(FIXTURE_NOW);
    const applied = await f.closer.mutation(confirm.confirmWhopPaymentNoShow, args);
    expect(applied).toMatchObject({ ok: true, alreadyApplied: false, decisionId: ask.decisionId });
    if (!applied.ok) throw new Error("Expected a confirmed no-show");
    const snapshot = await f.t.run(async (ctx) => ({
      meeting: await ctx.db.get("meetings", meetingId),
      deal: await ctx.db.get("opportunities", f.dealId),
      payment: await ctx.db.get("paymentRecords", applied.paymentRecordId),
      receipt: await ctx.db.get("resultAutomationDecisions", applied.decisionId),
      checks: await ctx.db.query("secondOpinions").take(2),
    }));
    expect(snapshot.meeting).toMatchObject({ status: "no_show", noShowMarkedAt: FIXTURE_NOW, noShowSource: "closer" });
    expect(snapshot.meeting?.attendanceOwedSince).toBeUndefined();
    expect(snapshot.deal).toMatchObject({ outcome: "won", humanResultRevision: 1 });
    expect(snapshot.payment).toMatchObject({ meetingId, origin: "provider", recordedByUserId: f.closerId });
    expect(snapshot.receipt).toMatchObject({ before: { meetings: [{ meetingId, status: "scheduled" }] }, appliedVia: "meeting_no_show", humanResultRevisionAfter: 1 });
    expect(snapshot.checks).toEqual([]);
    await invariant(f);
    expect(await f.closer.mutation(confirm.confirmWhopPaymentNoShow, args)).toEqual({ ...applied, alreadyApplied: true });
    await invariant(f);
  });
});
