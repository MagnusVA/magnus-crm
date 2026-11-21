import { afterEach, expect, it, vi } from "vitest";
import { assertPaymentInvariants } from "../../../tests/paymentInvariants";
import { insertProgram } from "../../../tests/enrollmentFixtures";
import { storeProofFile } from "../../../tests/proofFixtures";
import {
  FIXTURE_NOW,
  FIXTURE_PAID_AT,
  PRODUCT_ID,
  VARIANT_ID,
  insertProviderBinding,
  insertProviderDeal,
  insertProviderIdentifier,
  insertProviderMeeting,
  insertProviderPerson,
  setPaymentFixtureModes,
} from "../../../tests/providerPaymentFixtures";
import { ACCOUNT_ID, iso, paymentFixture, signedHeaders, whopFixture } from "../../../tests/whopFixtures";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { billingPaymentsByStatus } from "../../billing/aggregates";
import { rebuildLeadCustomerSearchRow } from "../../leadCustomers/projection";
import { paymentSums } from "../../reporting/aggregates";
import type { ExcludeArgs } from "../exclude";
import type { whopEventType } from "../whop/normalize";

type Attendance = Pick<Doc<"meetings">, "status" | "heldMarkedAt" | "noShowMarkedAt" | "canceledAt">;
type Cash = Record<string, number>;
type Payment = Doc<"paymentRecords">;
type Fixture = Awaited<ReturnType<typeof whopFixture>>;

const payer = {
  river: "river@example.com",
  sam: "sam@example.com",
  thirdParty: "jules@example.com",
};
const membershipId = "mem_sam_scenario";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function scenarioFixture() {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
  vi.stubEnv("WORKOS_CLIENT_ID", "client_fixture");
  vi.stubEnv("WORKOS_API_KEY", "sk_fixture");
  vi.stubEnv("WORKOS_WEBHOOK_SECRET", "whsec_fixture");
  const f = await whopFixture({
    connectedAt: FIXTURE_PAID_AT - 86_400_000,
    autoImportAfter: FIXTURE_PAID_AT - 86_400_000,
  });
  const ids = await f.t.run(async (ctx) => {
    const { tenantId, connectionId } = f;
    const users = await ctx.db.query("users").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)).take(3);
    const adminId = users.find((user) => user.role === "tenant_admin")!._id;
    const closerId = users.find((user) => user.role === "closer")!._id;
    await ctx.db.patch("tenants", tenantId, { billingOpsEnabled: true });
    await setPaymentFixtureModes(ctx, { tenantId, adminId });
    const programId = await insertProgram(ctx, tenantId, "Sales training");
    const secondProgramId = await insertProgram(ctx, tenantId, "Field coaching");
    await insertProviderBinding(ctx, {
      tenantId, connectionId, adminId, externalId: PRODUCT_ID, binding: { kind: "product_program", programId },
    });
    await insertProviderBinding(ctx, {
      tenantId, connectionId, adminId, externalId: VARIANT_ID,
      binding: { kind: "variant_type", paymentType: "pif", laterPaymentType: "split" },
    });

    const river = await insertProviderPerson(ctx, tenantId, { email: payer.river });
    const sam = await insertProviderPerson(ctx, tenantId, { fullName: "Sam Silva", email: payer.sam });
    await insertProviderIdentifier(ctx, tenantId, river, "email", payer.river);
    await insertProviderIdentifier(ctx, tenantId, sam, "email", payer.sam);
    async function booked(leadId: Id<"leads">, scheduledAt: number) {
      const dealId = await insertProviderDeal(ctx, { tenantId, leadId, assignedCloserId: closerId });
      const meetingId = await insertProviderMeeting(ctx, { tenantId, opportunityId: dealId, closerId, scheduledAt });
      return { dealId, meetingId };
    }
    const riverTraining = await booked(river, FIXTURE_NOW - 60 * 60_000);
    const riverCoaching = await booked(river, FIXTURE_NOW - 45 * 60_000);
    const samTraining = await booked(sam, FIXTURE_NOW - 30 * 60_000);
    await rebuildLeadCustomerSearchRow(ctx, tenantId, river);
    await rebuildLeadCustomerSearchRow(ctx, tenantId, sam);
    return { adminId, programId, secondProgramId, river, sam, riverTraining, riverCoaching, samTraining };
  });
  return { ...f, ...ids };
}

function addCash(cash: Cash, currency: string, amountMinor: number) {
  cash[currency] = (cash[currency] ?? 0) + amountMinor;
}

async function assertCash(f: Fixture, payments: Payment[], expected: Cash) {
  const byCurrency: Cash = {};
  const rowsByTime = new Map<number, Payment>();
  for (const row of payments) {
    // The aggregate has no currency dimension. Each recordedAt in this
    // fixture belongs to one payment, including rows later disputed.
    expect(rowsByTime.has(row.recordedAt)).toBe(false);
    rowsByTime.set(row.recordedAt, row);
    if (row.status !== "disputed") addCash(byCurrency, row.currency, row.amountMinor);
  }
  expect(byCurrency).toEqual(expected);
  await f.t.run(async (ctx) => {
    const byAggregateCurrency: Cash = {};
    for (const row of rowsByTime.values()) {
      const key: [Id<"users"> | "", number] = [row.attributedCloserId ?? "", row.recordedAt];
      const amount = await paymentSums.sum(ctx, {
        namespace: f.tenantId,
        bounds: { lower: { key, inclusive: true }, upper: { key, inclusive: true } },
      });
      if (row.status === "disputed") expect(amount).toBe(0);
      else addCash(byAggregateCurrency, row.currency, amount);
    }
    expect(byAggregateCurrency).toEqual(expected);
    expect(await paymentSums.sum(ctx, { namespace: f.tenantId }))
      .toBe(Object.values(expected).reduce((total, amount) => total + amount, 0));
    expect(await paymentSums.count(ctx, { namespace: f.tenantId })).toBe(payments.length);
    for (const status of ["recorded", "verified", "disputed"] as const) {
      expect(await billingPaymentsByStatus.count(ctx, { namespace: f.tenantId, bounds: { prefix: [status] } }))
        .toBe(payments.filter((row) => row.status === status).length);
    }
  });
}

type Delivery = { id: string; type: (typeof whopEventType.options)[number]; data: object };
type Scenario = Awaited<ReturnType<typeof scenarioFixture>>;

function signedIntake(f: Scenario) {
  const responses = new Map<string, object>();
  const history: Delivery[] = [];
  const fetchWhop = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const response = responses.get(path);
    if (!response) throw new Error(`No Whop fixture for ${path}`);
    vi.setSystemTime(Date.now() + 200);
    return Response.json(response);
  });
  vi.stubGlobal("fetch", fetchWhop);

  async function deliver({ id, type, data }: Delivery) {
    const body = JSON.stringify({ id, type, account_id: ACCOUNT_ID, data });
    const response = await f.t.fetch(`/webhooks/whop?c=${f.connectionId}`, {
      method: "POST",
      headers: await signedHeaders(body, id, undefined, Date.now()),
      body,
    });
    expect(response.status).toBe(200);
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  }
  function readPayment(id: string, email: string, amount: string, currency: string, overrides = {}) {
    responses.set(`/api/v1/payments/${id}`, paymentFixture({
      id, customer_email: email, customer_phone: null, billing_reason: "one_time",
      product_id: PRODUCT_ID, variant_id: VARIANT_ID, paid_at: iso(FIXTURE_PAID_AT),
      created_at: iso(FIXTURE_PAID_AT - 500), updated_at: iso(Date.now()),
      currency, total: { amount, currency, decimals: 2 }, ...overrides,
    }));
  }
  async function send(id: string, type: Delivery["type"], data: object) {
    const delivery = { id, type, data };
    history.push(delivery);
    await deliver(delivery);
  }
  const success = (id: string) => send(`msg_${id}`, "payment.succeeded", { id });

  return { responses, readPayment, send, success, history, deliver, fetchWhop };
}

async function bill(
  f: Scenario,
  providerPaymentId: Id<"providerPayments">,
  opportunityId: Id<"opportunities">,
  approval?: { programId: Id<"tenantPrograms">; paymentType: Payment["paymentType"] },
) {
  const target = { providerPaymentId, opportunityId };
  const { preview } = await f.admin.query(api.payments.confirm.previewWhopConfirm, target);
  if (!preview.ok) throw new Error(`Billing preview refused: ${preview.code}`);
  const applied = await f.admin.mutation(api.payments.confirm.confirmWhopPayment, {
    ...target, ...approval,
    expectedFingerprint: preview.fingerprint,
    expectedAllocationRevision: preview.allocationRevision,
  });
  if (!applied.ok) throw new Error(`Billing confirmation refused: ${applied.code}`);
  return applied.paymentRecordId;
}

async function exclude(f: Scenario, args: ExcludeArgs) {
  const { paymentRecordId, cause } = args;
  const preview = await f.admin.query(api.payments.exclude.previewExclusion, { paymentRecordId, cause });
  expect(preview.refusal).toBeUndefined();
  const result = await f.admin.mutation(api.payments.exclude.excludePayment, {
    ...args, expectedFingerprint: preview.fingerprint,
  });
  if (!result.ok) throw new Error(`Billing exclusion refused: ${result.code}`);
  return result.correctionId;
}

it("conserves cash through confirmations, a manual link, adverse reads, correction, restore and redelivery", async () => {
  const f = await scenarioFixture();
  const { t, tenantId, closer, admin, programId, secondProgramId, riverTraining, riverCoaching, samTraining } = f;
  const deals = [riverTraining, riverCoaching, samTraining];
  const attendance = new Map<Id<"meetings">, Attendance>(
    deals.map(({ meetingId }) => [meetingId, { status: "scheduled" }]),
  );
  const whop = signedIntake(f);
  const fact = (externalPaymentId: string) => t.run(async (ctx) => {
    const payment = await ctx.db.query("providerPayments")
      .withIndex("by_tenantId_and_connectionId_and_externalPaymentId", (q) =>
        q.eq("tenantId", tenantId).eq("connectionId", f.connectionId).eq("externalPaymentId", externalPaymentId))
      .unique();
    if (!payment) throw new Error(`Missing Whop payment ${externalPaymentId}`);
    return payment;
  });

  async function step<Result>(name: string, cash: Cash, action: () => Result | Promise<Result>) {
    vi.setSystemTime(Date.now() + 60_000);
    try {
      const result = await action();
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      await assertPaymentInvariants(t, { tenantId });
      const payments = await t.run(async (ctx) => {
        const payments = await ctx.db.query("paymentRecords").take(40);
        const counting = payments.filter((row) => row.status !== "disputed");
        for (const { dealId, meetingId } of deals) {
          const deal = (await ctx.db.get("opportunities", dealId))!;
          const { status, heldMarkedAt, noShowMarkedAt, canceledAt } = (await ctx.db.get("meetings", meetingId))!;
          expect({ status, heldMarkedAt, noShowMarkedAt, canceledAt }).toEqual(attendance.get(meetingId));
          const times = counting.filter((row) => row.opportunityId === dealId).map((row) => row.recordedAt);
          expect(deal.paymentReceivedAt).toBe(times.length ? Math.min(...times) : undefined);
        }
        const providerPayments = await ctx.db.query("providerPayments").take(20);
        for (const payment of providerPayments) {
          const allocated = counting.filter((row) => row.providerPaymentId === payment._id);
          expect(allocated.map((row) => row._id)).toEqual(payment.paymentRecordId ? [payment.paymentRecordId] : []);
          if (allocated[0]) expect(payment.opportunityId).toBe(allocated[0].opportunityId);
        }
        for (const row of counting) {
          if (!row.providerPaymentId) continue;
          const payment = providerPayments.find((payment) => payment._id === row.providerPaymentId);
          expect(payment).toMatchObject({ paymentRecordId: row._id, paidAt: row.providerPaidAt });
        }
        const people = await ctx.db.query("leads").take(3);
        expect(new Set(people.map((person) => person._id))).toEqual(new Set([f.river, f.sam]));
        for (const person of people) {
          const personDealIds = person._id === f.river ? [riverTraining.dealId, riverCoaching.dealId] : [samTraining.dealId];
          const personPayments = counting.filter((row) => row.opportunityId && personDealIds.includes(row.opportunityId))
            .sort((a, b) => a.recordedAt - b.recordedAt);
          const earliestByProgram = new Map<Id<"tenantPrograms">, Payment>();
          for (const row of personPayments) {
            if (row.programId && !earliestByProgram.has(row.programId)) earliestByProgram.set(row.programId, row);
          }
          const enrollments = await ctx.db.query("enrollments")
            .withIndex("by_tenantId_and_leadId_and_programId", (q) => q.eq("tenantId", tenantId).eq("leadId", person._id)).take(5);
          expect(enrollments).toHaveLength(earliestByProgram.size);
          for (const enrollment of enrollments) {
            const first = earliestByProgram.get(enrollment.programId);
            expect(first).toBeDefined();
            expect(enrollment).toMatchObject({ status: "active", opportunityId: first?.opportunityId, enrolledAt: first?.recordedAt });
          }
          const customer = personPayments.length > 0;
          expect(person.status).toBe(customer ? "converted" : "active");
          expect(person.lifecycleStage === "customer").toBe(customer);
          const searchRow = await ctx.db.query("leadCustomerSearchRows")
            .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", tenantId).eq("leadId", person._id)).unique();
          expect(searchRow).toMatchObject({ leadStatus: person.status });
          expect(searchRow?.lifecycle === "customer").toBe(customer);
          expect(searchRow?.customerStatus).toBe(customer ? "active" : undefined);
          expect(searchRow?.convertedAt).toBe(personPayments[0]?.recordedAt);
          expect(searchRow?.totalPaidMinor).toBe(customer ? personPayments.reduce((sum, row) => sum + row.amountMinor, 0) : undefined);
          const currencies = new Set(personPayments.map((row) => row.currency));
          expect(searchRow?.paymentCurrency).toBe(currencies.size === 1 ? personPayments[0].currency : undefined);
          expect(searchRow?.wonOpportunityCount).toBe(new Set(personPayments.map((row) => row.opportunityId)).size);
        }
        return payments;
      });
      await assertCash(f, payments, cash);
      return result;
    } catch (error) {
      throw new Error(`Step: ${name}`, { cause: error });
    }
  }

  await step("two people start with three booked deals and no cash", {}, () => {});
  const anchor = await step("Whop matches Sam's one open deal", {}, async () => {
    whop.readPayment("pay_sam_deposit", payer.sam, "100.00", "usd", { membership_id: membershipId });
    await whop.success("pay_sam_deposit");
    const payment = await fact("pay_sam_deposit");
    expect(payment).toMatchObject({ reviewState: "needs_person", reviewReason: "ready" });
    return payment;
  });

  const samDeposit = await step("the closer confirms the deposit and records Sam as attended", { USD: 10_000 }, async () => {
    const ask = await closer.query(api.payments.confirm.getWhopAsk, {
      target: { kind: "meeting", meetingId: samTraining.meetingId },
    });
    expect(ask).toMatchObject({ providerPaymentId: anchor._id, opportunityId: samTraining.dealId });
    const now = Date.now();
    const paymentId = await closer.mutation(api.closer.payments.logPayment, {
      opportunityId: samTraining.dealId, meetingId: samTraining.meetingId,
      amount: 100, currency: "USD", programId, paymentType: "pif",
      provider: {
        kind: "confirm", providerPaymentId: anchor._id, decisionId: ask!.decisionId,
        expectedAllocationRevision: anchor.allocationRevision,
      },
    });
    attendance.set(samTraining.meetingId, { status: "held", heldMarkedAt: now });
    return paymentId;
  });

  await step("bind Sam's membership to the confirmed deposit", { USD: 10_000 }, () =>
    t.run((ctx) => insertProviderBinding(ctx, {
      tenantId, connectionId: f.connectionId, adminId: f.adminId, externalId: membershipId,
      binding: { kind: "membership_deal", opportunityId: samTraining.dealId, leadId: f.sam, anchorPaymentRecordId: samDeposit },
    })),
  );

  let instalmentTotal = 0;
  for (const id of ["pay_instalment_one", "pay_instalment_two"]) {
    const payment = await step(`receive ${id} through the membership binding`, {
      USD: 10_000, ...(instalmentTotal && { EUR: instalmentTotal }),
    }, async () => {
      whop.readPayment(id, payer.thirdParty, "30.00", "eur", {
        membership_id: membershipId, billing_reason: "subscription_cycle",
      });
      await whop.success(id);
      const payment = await fact(id);
      expect(payment).toMatchObject({ reviewState: "needs_person", reviewReason: "ready", totalMinor: 3_000 });
      return payment;
    });
    instalmentTotal += 3_000;
    await step(`Billing confirms ${id} as a distinct instalment`, { USD: 10_000, EUR: instalmentTotal }, async () => {
      const recordId = await bill(f, payment._id, samTraining.dealId);
      expect(await fact(id)).toMatchObject({ matchMethod: "membership_binding", paymentRecordId: recordId });
    });
  }

  const manual = await step("the closer records River's payment with a mistyped amount", { USD: 25_100, EUR: 6_000 }, async () => {
    const now = Date.now();
    const id = await closer.mutation(api.closer.payments.logPayment, {
      opportunityId: riverTraining.dealId, meetingId: riverTraining.meetingId,
      amount: 151, currency: "USD", programId, paymentType: "pif", proofFileId: await storeProofFile(t),
    });
    attendance.set(riverTraining.meetingId, { status: "held", heldMarkedAt: now });
    return id;
  });

  const mistyped = await step("Whop delivers the same money at the correct amount", { USD: 25_100, EUR: 6_000 }, async () => {
    whop.readPayment("pay_river_manual_counterpart", payer.river, "150.00", "usd");
    await whop.success("pay_river_manual_counterpart");
    return fact("pay_river_manual_counterpart");
  });

  const link = {
    providerPaymentId: mistyped._id, paymentRecordId: manual, expectedAllocationRevision: mistyped.allocationRevision,
  };
  await step("Billing cannot link the mistyped payment without acknowledging the difference", { USD: 25_100, EUR: 6_000 }, async () => {
    await expect(admin.mutation(api.payments.review.linkToPaymentRecord, link))
      .rejects.toMatchObject({ data: { code: "provider_payment.amount_mismatch", crmAmountMinor: 15_100, providerTotalMinor: 15_000 } });
    expect(await fact(mistyped.externalPaymentId)).toEqual(mistyped);
  });
  await step("Billing answers 'it is that payment' and acknowledges both amounts", { USD: 25_100, EUR: 6_000 }, async () => {
    expect(await admin.mutation(api.payments.review.linkToPaymentRecord, {
      ...link, acknowledgedAmounts: { crmAmountMinor: 15_100, providerTotalMinor: 15_000 },
    })).toMatchObject({ paymentRecordId: manual });
    expect(await fact(mistyped.externalPaymentId)).toMatchObject({ reviewState: "linked", paymentRecordId: manual });
  });

  const refundId = "pay_refunded_before_success";
  const cashAfterLink = { USD: 25_100, EUR: 6_000 };
  await step("a full refund arrives before its payment success event", cashAfterLink, async () => {
    const amount = { amount: "45.00", currency: "usd", decimals: 2 };
    whop.readPayment(refundId, payer.river, "45.00", "usd", {
      substatus: "refunded", refunded_amount: amount, refunded_at: iso(Date.now()),
    });
    whop.responses.set("/api/v1/refunds/ref_scenario", {
      id: "ref_scenario", account_id: ACCOUNT_ID, payment_id: refundId,
      status: "succeeded", updated_at: iso(Date.now()), amount,
    });
    await whop.send("msg_refund_first", "refund.created", { id: "ref_scenario", payment: { id: refundId } });
    expect(await fact(refundId)).toMatchObject({ adverseState: "refunded", refundedMinor: 4_500 });
  });

  await step("the delayed success hits an older replica and cannot clear the refund", cashAfterLink, async () => {
    const refunded = await fact(refundId);
    whop.readPayment(refundId, payer.river, "45.00", "usd", { updated_at: iso(refunded.sourceUpdatedAt - 1) });
    await whop.success(refundId);
    expect(await fact(refundId)).toMatchObject({ adverseState: "refunded", refundedMinor: 4_500 });
  });

  async function dispute(status: "needs_response" | "won") {
    const id = "pay_instalment_one";
    whop.readPayment(id, payer.thirdParty, "30.00", "eur", {
      membership_id: membershipId, billing_reason: "subscription_cycle",
      substatus: status === "won" ? "dispute_won" : "dispute_needs_response",
    });
    const data = { id: "disp_scenario", payment: { id } };
    whop.responses.set("/api/v1/disputes/disp_scenario", {
      ...data, account_id: ACCOUNT_ID, status, updated_at: iso(Date.now()),
    });
    await whop.send(`msg_dispute_${status}`, status === "won" ? "dispute.updated" : "dispute.created", data);
    return fact(id);
  }

  await step("an open dispute flags a counted instalment for Billing", cashAfterLink, async () => {
    expect(await dispute("needs_response")).toMatchObject({ adverseState: "dispute_open", reviewState: "recorded" });
  });

  const disputeCorrection = await step("Billing excludes the disputed instalment and Sam stays won", { USD: 25_100, EUR: 3_000 }, async () => {
    const { paymentRecordId } = await fact("pay_instalment_one");
    return exclude(f, { paymentRecordId: paymentRecordId!, cause: "chargeback", level: "reviewed" });
  });

  await step("Whop reports the dispute won without putting cash back by itself", { USD: 25_100, EUR: 3_000 }, async () => {
    expect(await dispute("won")).toMatchObject({ adverseState: "dispute_won", reviewState: "needs_person" });
  });

  await step("Billing restores the instalment after the dispute is won", cashAfterLink, async () => {
    const args = { correctionId: disputeCorrection };
    const preview = await admin.query(api.payments.restore.previewRestore, args);
    expect(preview).toMatchObject({
      result: "restored_kept_won", cashDeltaByCurrency: [{ currency: "EUR", amountMinor: 3_000 }],
    });
    expect(await admin.mutation(api.payments.restore.restorePayment, { ...args, expectedFingerprint: preview.fingerprint }))
      .toMatchObject({ ok: true, alreadyApplied: false });
  });

  const thirdParty = await step("the third-party payer has no CRM person to match", cashAfterLink, async () => {
    whop.readPayment("pay_third_party", payer.thirdParty, "70.00", "usd", { product_id: undefined });
    await whop.success("pay_third_party");
    const payment = await fact("pay_third_party");
    expect(payment).toMatchObject({ reviewState: "needs_person", reviewReason: "unknown_payer" });
    return payment;
  });

  const cashWithThirdParty = { USD: 32_100, EUR: 6_000 };
  const wrong = await step("Billing puts the third-party payment on Sam's deal by mistake", cashWithThirdParty, () =>
    bill(f, thirdParty._id, samTraining.dealId, { programId, paymentType: "split" }),
  );

  const wrongCorrection = await step("Billing takes the payment off Sam's deal", cashAfterLink, () =>
    exclude(f, { paymentRecordId: wrong, cause: "wrong_match", level: "reviewed" }),
  );

  const corrected = await step("Billing confirms the same Whop payment for River's coaching deal", cashWithThirdParty, async () => {
    const paymentRecordId = await bill(f, thirdParty._id, riverCoaching.dealId, {
      programId: secondProgramId, paymentType: "pif",
    });
    expect(await fact(thirdParty.externalPaymentId)).toMatchObject({
      opportunityId: riverCoaching.dealId, paymentRecordId, excludedOpportunityIds: [samTraining.dealId],
    });
    expect(await admin.query(api.payments.restore.previewRestore, { correctionId: wrongCorrection }))
      .toMatchObject({ refusal: "reallocated" });
    return paymentRecordId;
  });

  await step("the closer separately records that River missed the coaching call", cashWithThirdParty, async () => {
    const now = Date.now();
    expect(await closer.mutation(api.closer.attendanceOnly.recordAttendanceOnly, {
      meetingId: riverCoaching.meetingId, attendance: "no_show",
    })).toMatchObject({ ok: true });
    attendance.set(riverCoaching.meetingId, { status: "no_show", noShowMarkedAt: now });
  });

  const mistakenExclusion = await step("Billing accidentally excludes River's coaching payment", cashAfterLink, () =>
    exclude(f, { paymentRecordId: corrected, cause: "wrong_match", level: "reviewed", disposition: "lost" }),
  );

  const restoreArgs = await step("Billing restores the mistaken exclusion", cashWithThirdParty, async () => {
    const { fingerprint, result } = await admin.query(api.payments.restore.previewRestore, { correctionId: mistakenExclusion });
    expect(result).toBe("restored_won");
    const args = { correctionId: mistakenExclusion, expectedFingerprint: fingerprint };
    expect(await admin.mutation(api.payments.restore.restorePayment, args)).toMatchObject({ ok: true, alreadyApplied: false });
    expect(await fact(thirdParty.externalPaymentId)).toMatchObject({
      opportunityId: riverCoaching.dealId, paymentRecordId: corrected, excludedOpportunityIds: [samTraining.dealId],
    });
    return args;
  });

  await step("retrying the restore changes nothing", cashWithThirdParty, async () => {
    expect(await admin.mutation(api.payments.restore.restorePayment, restoreArgs)).toMatchObject({ ok: true, alreadyApplied: true });
  });

  const readCount = whop.fetchWhop.mock.calls.length;
  for (const delivery of whop.history) {
    await step(`redeliver ${delivery.id}`, cashWithThirdParty, async () => {
      await whop.deliver(delivery);
      expect(whop.fetchWhop).toHaveBeenCalledTimes(readCount);
      const receipts = await t.run((ctx) => ctx.db.query("paymentWebhookReceipts").take(20));
      expect(receipts.map((receipt) => receipt.webhookId).sort()).toEqual(whop.history.map((item) => item.id).sort());
    });
  }
});
