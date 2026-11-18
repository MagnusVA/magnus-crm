import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertOtherTenant } from "../../tests/dealStateFixtures";
import { insertPayment } from "../../tests/enrollmentFixtures";
import {
  FIXTURE_NOW,
  FIXTURE_PAID_AT,
  PAYER_EMAIL,
  insertProviderBinding,
  insertProviderDeal,
  insertProviderFact,
  insertProviderPerson,
  providerPaymentFixture,
} from "../../tests/providerPaymentFixtures";
import { api } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
  billingPaymentsByStatus,
  billingPaymentsByStatusProgram,
  billingPaymentsByStatusProgramType,
  billingPaymentsByStatusType,
} from "../billing/aggregates";
import { moveOpportunityToLead } from "../leads/repointLeadReferences";
import { opportunityByStage, paymentSums } from "../reporting/aggregates";
import { insertPaymentAggregate } from "../reporting/writeHooks";
import { refreshProviderPaymentReview } from "./match";

const review = api.payments.review;

type Fixture = Awaited<ReturnType<typeof providerPaymentFixture>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => vi.useRealTimers());

function refresh(fixture: Fixture) {
  return fixture.t.run((ctx) => refreshProviderPaymentReview(ctx, fixture.providerPaymentId));
}

async function manualRecord(fixture: Fixture, fields: Partial<Doc<"paymentRecords">> = {}) {
  return await fixture.t.run(async (ctx) => {
    const id = await insertPayment(ctx, {
      tenantId: fixture.tenantId, opportunityId: fixture.dealId!, programId: fixture.programId,
      recordedAt: FIXTURE_NOW - 100, status: fields.status,
    });
    await ctx.db.patch("paymentRecords", id, {
      attributedCloserId: fixture.closerId,
      referenceCode: "human-reference",
      ...fields,
    });
    await insertPaymentAggregate(ctx, id);
    return id;
  });
}

describe("provider exception reads", () => {
  it("lists only its own exceptions oldest first and reports connection freshness", async () => {
    const fixture = await providerPaymentFixture();
    await refresh(fixture);
    const newest = await fixture.t.run(async (ctx) => {
      const otherTenant = await insertOtherTenant(ctx);
      await insertProviderFact(ctx, otherTenant, fixture.connectionId, { firstSeenAt: 0, reviewState: "needs_person" });
      await insertProviderFact(ctx, fixture.tenantId, fixture.connectionId, {
        externalPaymentId: "pay_hidden", firstSeenAt: 1, reviewState: "dismissed",
      });
      return await insertProviderFact(ctx, fixture.tenantId, fixture.connectionId, {
        externalPaymentId: "pay_newest", firstSeenAt: FIXTURE_NOW, reviewState: "needs_person",
        reviewReason: "unknown_payer", payerEmail: "partner@example.com",
      });
    });

    const listed = await fixture.admin.query(review.listProviderExceptions, { paginationOpts: { numItems: 1, cursor: null } });
    expect(listed.page).toEqual([expect.objectContaining({
      providerPaymentId: fixture.providerPaymentId,
      totalMinor: 10000, currency: "USD", paidAt: FIXTURE_PAID_AT,
      firstSeenAt: FIXTURE_NOW - 2000, reviewReason: "ready", payerEmail: PAYER_EMAIL,
      productTitle: "Sales training", variantTitle: "Pay in full", sweepFresh: true,
      candidatePerson: { leadId: fixture.personId, displayName: "River Patel" },
      candidateDeal: expect.objectContaining({ opportunityId: fixture.dealId, stage: "booked" }),
    })]);
    const next = await fixture.admin.query(review.listProviderExceptions, {
      paginationOpts: { numItems: 1, cursor: listed.continueCursor },
    });
    expect(next.page.map((item) => item.providerPaymentId)).toEqual([newest]);
    expect(await fixture.admin.query(review.getProviderExceptionCounts, {})).toEqual({ count: 2, capped: false });

    vi.setSystemTime(FIXTURE_NOW + 16 * 60_000);
    const stale = await fixture.admin.query(review.listProviderExceptions, { paginationOpts: { numItems: 10, cursor: null } });
    expect(stale.page.every((row) => !row.sweepFresh)).toBe(true);
  });

  it("reports the count as capped only when more rows exist", async () => {
    const fixture = await providerPaymentFixture();
    await fixture.t.run(async (ctx) => {
      for (let index = 0; index < 500; index++) {
        await insertProviderFact(ctx, fixture.tenantId, fixture.connectionId, {
          externalPaymentId: `pay_${index}`, reviewState: "needs_person",
        });
      }
    });
    expect(await fixture.admin.query(review.getProviderExceptionCounts, {})).toEqual({ count: 500, capped: false });
    await refresh(fixture);
    expect(await fixture.admin.query(review.getProviderExceptionCounts, {})).toEqual({ count: 500, capped: true });
  });

  it("recomputes live and returns counting, unlinked CRM payments across the person's deals", async () => {
    const fixture = await providerPaymentFixture();
    await refresh(fixture);
    const eligible = await manualRecord(fixture);
    await manualRecord(fixture, { status: "disputed" });
    await manualRecord(fixture, { providerPaymentId: fixture.providerPaymentId });
    await fixture.t.run(async (ctx) => {
      const otherDeal = await insertProviderDeal(ctx, { ...fixture, leadId: fixture.personId, status: "payment_received" });
      await insertPayment(ctx, {
        tenantId: fixture.tenantId, opportunityId: otherDeal, programId: fixture.programId, recordedAt: 5,
      });
    });
    const detail = await fixture.admin.query(review.getProviderPayment, { providerPaymentId: fixture.providerPaymentId });
    expect(detail).toMatchObject({
      payment: { reviewReason: "ready", payerEmail: PAYER_EMAIL },
      classification: { kind: "needs_person", reason: "unlinked_manual_payment" },
      candidateDeals: [expect.objectContaining({ opportunityId: fixture.dealId })],
      manualPaymentsCapped: false,
    });
    expect(detail?.manualPayments).toHaveLength(2);
    expect(detail?.manualPayments[0]).toEqual({
      paymentRecordId: eligible, opportunityId: fixture.dealId,
      amountMinor: 10000, currency: "USD", paymentType: "pif",
      programId: fixture.programId, programName: "Program",
      recordedAt: FIXTURE_NOW - 100, recordedByUserId: fixture.adminId, recordedByName: "admin@example.com",
    });
  });

  it("lets a reviewer choose a CRM person for an unknown payer", async () => {
    const fixture = await providerPaymentFixture({ fact: { payerEmail: "partner@example.com" } });
    const record = await manualRecord(fixture);
    const detail = await fixture.admin.query(review.getProviderPayment, {
      providerPaymentId: fixture.providerPaymentId, leadId: fixture.personId,
    });
    expect(detail?.classification).toMatchObject({ reason: "unknown_payer" });
    expect(detail?.manualPayments[0].paymentRecordId).toBe(record);
  });
});

describe("manual evidence links", () => {
  it("links, retries, and unlinks without changing cash, CRM payment data, deals or enrollments", async () => {
    const fixture = await providerPaymentFixture();
    const paymentRecordId = await manualRecord(fixture);
    const args = { providerPaymentId: fixture.providerPaymentId, paymentRecordId, acknowledgeAmountDifference: false };
    const payment = () => fixture.t.run((ctx) => ctx.db.get("paymentRecords", paymentRecordId));
    const reports = () => fixture.t.run(async (ctx) => {
      const index = { namespace: fixture.tenantId };
      return {
        sums: [await paymentSums.count(ctx, index), await paymentSums.sum(ctx, index)],
        billing: await Promise.all([
          billingPaymentsByStatus.count(ctx, index),
          billingPaymentsByStatusProgram.count(ctx, index),
          billingPaymentsByStatusProgramType.count(ctx, index),
          billingPaymentsByStatusType.count(ctx, index),
        ]),
        dealCount: await opportunityByStage.count(ctx, index),
        deal: await ctx.db.get("opportunities", fixture.dealId!),
        lead: await ctx.db.get("leads", fixture.personId),
        enrollments: await ctx.db.query("enrollments").take(10),
      };
    });
    const initial = await payment();
    const baseline = await reports();
    expect(baseline.sums).toEqual([1, 10000]);
    expect(await fixture.admin.mutation(review.linkToPaymentRecord, args)).toBeNull();
    expect(await payment()).toEqual({
      ...initial, providerPaymentId: fixture.providerPaymentId, providerPaidAt: FIXTURE_PAID_AT,
    });
    const evidence = await fixture.admin.query(review.getLinkedProviderPayment, { paymentRecordId });
    expect(evidence).toMatchObject({
      paymentRecordId, leadId: fixture.personId, opportunityId: fixture.dealId,
      reviewState: "linked", matchMethod: "person", resolvedByUserId: fixture.adminId,
      resolvedAt: FIXTURE_NOW,
    });
    expect(await reports()).toEqual(baseline);

    vi.setSystemTime(FIXTURE_NOW + 1000);
    expect(await fixture.admin.mutation(review.linkToPaymentRecord, args)).toBeNull();
    expect(await fixture.admin.query(review.getLinkedProviderPayment, { paymentRecordId })).toEqual(evidence);
    expect(await fixture.admin.mutation(review.unlinkPaymentRecord, { providerPaymentId: fixture.providerPaymentId })).toBeNull();
    expect(await payment()).toEqual(initial);
    expect(await fixture.admin.query(review.getLinkedProviderPayment, { paymentRecordId })).toBeNull();
    const detail = await fixture.admin.query(review.getProviderPayment, { providerPaymentId: fixture.providerPaymentId });
    expect(detail?.payment).toMatchObject({
      reviewState: "needs_person", reviewReason: "unlinked_manual_payment", candidateLeadId: fixture.personId,
    });
    expect(detail?.payment.paymentRecordId).toBeUndefined();
    expect(detail?.payment.leadId).toBeUndefined();
    expect(detail?.payment.opportunityId).toBeUndefined();
    expect(detail?.payment.resolvedByUserId).toBeUndefined();
    expect(await reports()).toEqual(baseline);

    const events = await fixture.t.run((ctx) => ctx.db.query("domainEvents")
      .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
        q.eq("tenantId", fixture.tenantId).eq("entityType", "payment").eq("entityId", paymentRecordId))
      .take(10));
    expect(events.map(({ actorUserId, eventType, metadata }) => ({ actorUserId, eventType, metadata }))).toEqual(
      ["payment.provider_linked", "payment.provider_unlinked"].map((eventType) => ({
        actorUserId: fixture.adminId,
        eventType,
        metadata: JSON.stringify({ providerPaymentId: fixture.providerPaymentId, paymentRecordId }),
      })),
    );
  });

  it("requires explicit acknowledgement for unequal amounts and preserves the human amount", async () => {
    const fixture = await providerPaymentFixture();
    const paymentRecordId = await manualRecord(fixture, { amountMinor: 12000 });
    const args = { providerPaymentId: fixture.providerPaymentId, paymentRecordId };
    await expect(fixture.admin.mutation(review.linkToPaymentRecord, { ...args, acknowledgeAmountDifference: false }))
      .rejects.toThrow(/provider_payment\.amount_mismatch/);
    expect(await fixture.admin.query(review.getLinkedProviderPayment, { paymentRecordId })).toBeNull();
    await fixture.admin.mutation(review.linkToPaymentRecord, { ...args, acknowledgeAmountDifference: true });
    expect(await fixture.t.run((ctx) => ctx.db.get("paymentRecords", paymentRecordId)))
      .toMatchObject({ providerPaymentId: fixture.providerPaymentId, amountMinor: 12000 });
  });

  it.each([
    ["currency_mismatch", { currency: "EUR" }],
    ["record_disputed", { status: "disputed" }],
  ] as const)("refuses a %s even with amount acknowledgement", async (code, fields) => {
    const fixture = await providerPaymentFixture();
    const paymentRecordId = await manualRecord(fixture, fields);
    await expect(fixture.admin.mutation(review.linkToPaymentRecord, {
      providerPaymentId: fixture.providerPaymentId, paymentRecordId, acknowledgeAmountDifference: true,
    })).rejects.toThrow(`provider_payment.${code}`);
  });

  it("refuses a second CRM record and the same CRM record on another provider payment", async () => {
    const fixture = await providerPaymentFixture();
    const firstRecord = await manualRecord(fixture);
    const secondRecord = await manualRecord(fixture);
    const anotherProvider = await fixture.t.run((ctx) => insertProviderFact(ctx, fixture.tenantId, fixture.connectionId, {
      externalPaymentId: "pay_another",
    }));
    await fixture.admin.mutation(review.linkToPaymentRecord, {
      providerPaymentId: fixture.providerPaymentId, paymentRecordId: firstRecord, acknowledgeAmountDifference: false,
    });
    await expect(fixture.admin.mutation(review.linkToPaymentRecord, {
      providerPaymentId: fixture.providerPaymentId, paymentRecordId: secondRecord, acknowledgeAmountDifference: false,
    })).rejects.toThrow(/provider_payment\.already_allocated/);
    await expect(fixture.admin.mutation(review.linkToPaymentRecord, {
      providerPaymentId: anotherProvider, paymentRecordId: firstRecord, acknowledgeAmountDifference: false,
    })).rejects.toThrow(/provider_payment\.record_already_linked/);
  });

  it("refuses an unpaid provider payment", async () => {
    const fixture = await providerPaymentFixture({ fact: { status: "pending" } });
    const paymentRecordId = await manualRecord(fixture);
    await expect(fixture.admin.mutation(review.linkToPaymentRecord, {
      providerPaymentId: fixture.providerPaymentId, paymentRecordId, acknowledgeAmountDifference: true,
    })).rejects.toThrow(/provider_payment\.not_paid/);
  });

  it("refuses a counting backlink without an active pointer and permits a disputed history row", async () => {
    const fixture = await providerPaymentFixture();
    const { providerPaymentId } = fixture;
    const prior = await manualRecord(fixture, { providerPaymentId });
    const paymentRecordId = await manualRecord(fixture);
    const args = { providerPaymentId, paymentRecordId, acknowledgeAmountDifference: false };
    await expect(fixture.admin.mutation(review.linkToPaymentRecord, args))
      .rejects.toThrow(/provider_payment\.already_allocated/);
    await fixture.t.run((ctx) => ctx.db.patch("paymentRecords", prior, { status: "disputed" }));
    expect(await fixture.admin.mutation(review.linkToPaymentRecord, args)).toBeNull();
  });

  it("does not link either direction across tenants", async () => {
    const fixture = await providerPaymentFixture();
    const ownRecord = await manualRecord(fixture);
    const other = await fixture.t.run(async (ctx) => {
      const tenantId = await insertOtherTenant(ctx);
      const leadId = await insertProviderPerson(ctx, tenantId, { email: "other@example.com" });
      const opportunityId = await insertProviderDeal(ctx, { tenantId, leadId });
      return {
        recordId: await insertPayment(ctx, { tenantId, opportunityId, programId: fixture.programId, recordedAt: 1 }),
        providerPaymentId: await insertProviderFact(ctx, tenantId, fixture.connectionId),
      };
    });

    await expect(fixture.admin.mutation(review.linkToPaymentRecord, {
      providerPaymentId: fixture.providerPaymentId, paymentRecordId: other.recordId, acknowledgeAmountDifference: false,
    })).rejects.toThrow(/provider_payment\.record_not_found/);
    await expect(fixture.admin.mutation(review.linkToPaymentRecord, {
      providerPaymentId: other.providerPaymentId, paymentRecordId: ownRecord, acknowledgeAmountDifference: false,
    })).rejects.toThrow(/provider_payment\.not_found/);
    expect(await fixture.admin.query(review.getProviderPayment, { providerPaymentId: other.providerPaymentId })).toBeNull();
    expect(await fixture.admin.query(review.getLinkedProviderPayment, { paymentRecordId: other.recordId })).toBeNull();
  });

  it("disables a membership binding when its manual anchor is unlinked", async () => {
    const fixture = await providerPaymentFixture({ fact: { membershipId: "mem_anchor" } });
    const paymentRecordId = await manualRecord(fixture);
    const { providerPaymentId, personId, dealId } = fixture;
    await fixture.admin.mutation(review.linkToPaymentRecord, {
      providerPaymentId, paymentRecordId, acknowledgeAmountDifference: false,
    });
    const bindingId = await fixture.t.run((ctx) => insertProviderBinding(ctx, {
      ...fixture, externalId: "mem_anchor",
      binding: { kind: "membership_deal", leadId: personId, opportunityId: dealId!, anchorPaymentRecordId: paymentRecordId },
    }));
    await fixture.admin.mutation(review.unlinkPaymentRecord, { providerPaymentId });
    expect(await fixture.t.run((ctx) => ctx.db.get("paymentProviderBindings", bindingId)))
      .toMatchObject({ enabled: false, disabledReason: "anchor_undone", version: 2 });
  });
});

describe("review decisions and permissions", () => {
  it("dismisses with an allowlisted code and reopens against the live classification", async () => {
    const fixture = await providerPaymentFixture();
    await refresh(fixture);
    const { providerPaymentId } = fixture;
    await fixture.admin.mutation(review.dismissProviderPayment, { providerPaymentId, reason: "test_payment" });
    await fixture.t.run((ctx) => ctx.db.patch("providerPayments", providerPaymentId, { lineItemCount: 2 }));
    const detail = await fixture.admin.query(review.getProviderPayment, { providerPaymentId });
    expect(detail?.payment).toMatchObject({ reviewState: "dismissed", resolvedByUserId: fixture.adminId });
    expect(await fixture.admin.query(review.getProviderExceptionCounts, {})).toEqual({ count: 0, capped: false });

    await fixture.admin.mutation(review.reopenProviderPayment, { providerPaymentId });
    const reopened = await fixture.admin.query(review.getProviderPayment, { providerPaymentId });
    expect(reopened?.payment).toMatchObject({ reviewState: "needs_person", reviewReason: "multi_item" });
    expect(reopened?.payment.resolvedByUserId).toBeUndefined();
  });

  it("requires an authenticated Billing admin and an enabled tenant for each entry point", async () => {
    const fixture = await providerPaymentFixture();
    const { providerPaymentId } = fixture;
    const paymentRecordId = await manualRecord(fixture);
    const attempts = (client: Fixture["admin"] | Fixture["t"]) => [
      client.query(review.listProviderExceptions, { paginationOpts: { numItems: 10, cursor: null } }),
      client.query(review.getProviderExceptionCounts, {}),
      client.query(review.getProviderPayment, { providerPaymentId }),
      client.query(review.getLinkedProviderPayment, { paymentRecordId }),
      client.mutation(review.linkToPaymentRecord, { providerPaymentId, paymentRecordId, acknowledgeAmountDifference: false }),
      client.mutation(review.unlinkPaymentRecord, { providerPaymentId }),
      client.mutation(review.dismissProviderPayment, { providerPaymentId, reason: "other" }),
      client.mutation(review.reopenProviderPayment, { providerPaymentId }),
    ];
    for (const client of [fixture.t, fixture.closer]) {
      const results = await Promise.allSettled(attempts(client));
      expect(results.map(({ status }) => status)).toEqual(Array(8).fill("rejected"));
    }
    await fixture.t.run((ctx) => ctx.db.patch("tenants", fixture.tenantId, { billingOpsEnabled: false }));
    const results = await Promise.allSettled(attempts(fixture.admin));
    expect(results.map(({ status }) => status)).toEqual(Array(8).fill("rejected"));
  });

  it("repoints both fields on a merge, including a candidate without a deal", async () => {
    const fixture = await providerPaymentFixture();
    await refresh(fixture);
    const paymentRecordId = await manualRecord(fixture);
    await fixture.admin.mutation(review.linkToPaymentRecord, {
      providerPaymentId: fixture.providerPaymentId, paymentRecordId, acknowledgeAmountDifference: false,
    });
    const [targetLeadId, candidate] = await fixture.t.run(async (ctx) => [
      await insertProviderPerson(ctx, fixture.tenantId, { email: "survivor@example.com" }),
      await insertProviderFact(ctx, fixture.tenantId, fixture.connectionId, {
        externalPaymentId: "pay_candidate", candidateLeadId: fixture.personId, reviewState: "needs_person",
      }),
    ]);
    await fixture.admin.mutation(api.leads.merge.mergeLead, { sourceLeadId: fixture.personId, targetLeadId });
    const linked = await fixture.admin.query(review.getLinkedProviderPayment, { paymentRecordId });
    expect(linked).toMatchObject({ leadId: targetLeadId, candidateLeadId: targetLeadId });
    expect(await fixture.t.run((ctx) => ctx.db.get("providerPayments", candidate)))
      .toMatchObject({ candidateLeadId: targetLeadId });
  });

  it("repoints only evidence for a moved deal when its original person stays", async () => {
    const fixture = await providerPaymentFixture();
    await refresh(fixture);
    const { tenantId, dealId, providerPaymentId, personId } = fixture;
    const paymentRecordId = await manualRecord(fixture);
    await fixture.admin.mutation(review.linkToPaymentRecord, { providerPaymentId, paymentRecordId, acknowledgeAmountDifference: false });
    const [toLeadId, untouched] = await fixture.t.run(async (ctx) => [
      await insertProviderPerson(ctx, tenantId, { email: "other-person@example.com" }),
      await insertProviderFact(ctx, tenantId, fixture.connectionId, {
        externalPaymentId: "pay_untouched", candidateLeadId: personId,
      }),
    ]);
    await fixture.t.run((ctx) => moveOpportunityToLead(ctx, {
      tenantId, opportunityId: dealId!, toLeadId, leadName: "Casey Ellis", now: FIXTURE_NOW, moveFormResponses: true,
    }));
    const moved = await fixture.admin.query(review.getLinkedProviderPayment, { paymentRecordId });
    expect(moved).toMatchObject({ leadId: toLeadId, candidateLeadId: toLeadId, opportunityId: dealId });
    expect(await fixture.t.run((ctx) => ctx.db.get("providerPayments", untouched)))
      .toMatchObject({ candidateLeadId: personId });
  });
});
