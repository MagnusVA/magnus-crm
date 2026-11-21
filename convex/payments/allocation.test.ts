import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { insertPaymentAggregate } from "../reporting/writeHooks";
import { FIXTURE_NOW, FIXTURE_PAID_AT, providerPaymentFixture } from "../../tests/providerPaymentFixtures";
import { assertPaymentInvariants, seedProviderWin, seedUndoToBooked } from "../../tests/paymentInvariants";
import { refreshProviderPaymentReview } from "./match";
import {
  EXCLUDED_OPPORTUNITY_LIMIT,
  clearActiveAllocation,
  readActiveAllocation,
  setActiveAllocation,
} from "./allocation";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

type Harness = Awaited<ReturnType<typeof providerPaymentFixture>>;

async function wonFromWhop() {
  const h = await providerPaymentFixture({ dealPosition: "booked" });
  const paymentRecordId = await h.t.run((ctx) => seedProviderWin(ctx, {
    tenantId: h.tenantId, opportunityId: h.dealId!, providerPaymentId: h.providerPaymentId, programId: h.programId,
    closerId: h.closerId, approverId: h.adminId, recordedAt: FIXTURE_PAID_AT,
  }));
  return { ...h, dealId: h.dealId!, paymentRecordId };
}

const read = (h: Harness, paymentRecordId?: Id<"paymentRecords">) => h.t.run(async (ctx) => ({
  payment: (await ctx.db.get("providerPayments", h.providerPaymentId))!,
  record: paymentRecordId ? await ctx.db.get("paymentRecords", paymentRecordId) : null,
  events: (await ctx.db.query("domainEvents")
    .withIndex("by_tenantId_and_occurredAt", (q) => q.eq("tenantId", h.tenantId)).take(200)).length,
}));

/** A payment typed by hand on the fixture's deal, counted in the aggregates. */
async function manualRow(h: Harness) {
  return await h.t.run(async (ctx) => {
    const id = await ctx.db.insert("paymentRecords", {
      tenantId: h.tenantId, opportunityId: h.dealId!, attributedCloserId: h.closerId, amountMinor: 10000,
      currency: "USD", recordedByUserId: h.adminId, programId: h.programId, programName: "Sales training",
      paymentType: "pif", status: "recorded", recordedAt: FIXTURE_PAID_AT, origin: "admin_meeting", recordedVia: "web",
    });
    await insertPaymentAggregate(ctx, id);
    return id;
  });
}

/**
 * What a matcher that honours the veto would propose: the stored candidate,
 * unless a person took the payment off that deal. The matcher change itself
 * belongs to the corrections package; this reads only the list.
 */
function proposalHonouringVeto(payment: Doc<"providerPayments">) {
  const candidate = payment.candidateOpportunityId;
  return candidate && !(payment.excludedOpportunityIds ?? []).includes(candidate) ? candidate : undefined;
}

describe("setActiveAllocation", () => {
  it("points both rows at each other, resolves the payment and emits nothing", async () => {
    const h = await providerPaymentFixture({ dealPosition: "won" });
    const recordId = await manualRow(h);
    const before = await read(h, recordId);

    await h.t.run(async (ctx) => setActiveAllocation(ctx, {
      payment: (await ctx.db.get("providerPayments", h.providerPaymentId))!,
      record: (await ctx.db.get("paymentRecords", recordId))!,
      expectedAllocationRevision: 0, reviewState: "linked", matchMethod: "person", actorUserId: h.adminId, now: FIXTURE_NOW,
    }));

    const { payment, record, events } = await read(h, recordId);
    expect(payment).toMatchObject({
      paymentRecordId: recordId, allocationRevision: 1, leadId: h.personId, opportunityId: h.dealId,
      matchMethod: "person", reviewState: "linked", resolvedAt: FIXTURE_NOW, resolvedByUserId: h.adminId,
    });
    expect(payment.reviewReason).toBeUndefined();
    expect(payment.adverseReviewAt).toBeUndefined();
    expect(record).toMatchObject({ providerPaymentId: h.providerPaymentId, providerPaidAt: payment.paidAt });
    expect(events).toBe(before.events);
    expect(await h.t.run((ctx) => readActiveAllocation(ctx, payment))).toMatchObject({ _id: recordId });
  });

  it("keeps the reciprocal pointer invariant through a Whop win", async () => {
    const h = await wonFromWhop();
    const { payment } = await read(h);
    expect(payment).toMatchObject({ paymentRecordId: h.paymentRecordId, reviewState: "recorded", allocationRevision: 1 });
    await assertPaymentInvariants(h.t, { tenantId: h.tenantId });
  });

  it("refuses a second counting row for the same payment", async () => {
    const h = await wonFromWhop();
    const otherId = await manualRow(h);
    await expect(h.t.run(async (ctx) => {
      await ctx.db.patch("providerPayments", h.providerPaymentId, { paymentRecordId: undefined, reviewState: "needs_person" });
      await setActiveAllocation(ctx, {
        payment: (await ctx.db.get("providerPayments", h.providerPaymentId))!,
        record: (await ctx.db.get("paymentRecords", otherId))!,
        expectedAllocationRevision: 1, reviewState: "linked", matchMethod: "person", actorUserId: h.adminId, now: FIXTURE_NOW,
      });
    })).rejects.toThrow("A counting CRM payment already has this evidence");
  });

  it("refuses a stale revision and writes nothing", async () => {
    const h = await providerPaymentFixture({ dealPosition: "won" });
    const recordId = await manualRow(h);
    await h.t.run(async (ctx) => { await ctx.db.patch("providerPayments", h.providerPaymentId, { allocationRevision: 3 }); });
    const before = await read(h, recordId);
    await expect(h.t.run(async (ctx) => setActiveAllocation(ctx, {
      payment: (await ctx.db.get("providerPayments", h.providerPaymentId))!,
      record: (await ctx.db.get("paymentRecords", recordId))!,
      expectedAllocationRevision: 2, reviewState: "linked", matchMethod: "person", actorUserId: h.adminId, now: FIXTURE_NOW,
    }))).rejects.toThrow("Someone else changed this payment");
    const errorData = await h.t.run(async (ctx) => setActiveAllocation(ctx, {
      payment: (await ctx.db.get("providerPayments", h.providerPaymentId))!,
      record: (await ctx.db.get("paymentRecords", recordId))!,
      expectedAllocationRevision: 2, reviewState: "linked", matchMethod: "person", actorUserId: h.adminId, now: FIXTURE_NOW,
    }).then(() => null, (error: { data?: { code?: string } }) => error.data?.code ?? null));
    expect(errorData).toBe("provider_payment.changed");
    expect(await read(h, recordId)).toEqual(before);
  });

  it("re-reads the payment instead of trusting the caller's copy", async () => {
    const h = await wonFromWhop();
    // A snapshot taken before the allocation still says revision 0 and no pointer.
    const stale = { ...(await read(h)).payment, allocationRevision: 0, paymentRecordId: undefined };
    await expect(h.t.run(async (ctx) => setActiveAllocation(ctx, {
      payment: stale, record: (await ctx.db.get("paymentRecords", h.paymentRecordId))!,
      expectedAllocationRevision: 0, reviewState: "recorded", matchMethod: "person", actorUserId: h.adminId, now: FIXTURE_NOW,
    }))).rejects.toThrow("Someone else changed this payment");
  });

  it("takes the deal off the payment's veto list only on restore", async () => {
    const h = await providerPaymentFixture({ dealPosition: "booked" });
    const otherDeal = await h.t.run(async (ctx) => {
      const id = await ctx.db.insert("opportunities", {
        stage: "closed", outcome: "lost", lostReason: "stale", source: "calendly", tenantId: h.tenantId, leadId: h.personId,
        createdAt: 0, updatedAt: 0,
      });
      await ctx.db.patch("providerPayments", h.providerPaymentId, { excludedOpportunityIds: [h.dealId!, id] });
      return id;
    });
    const args = {
      tenantId: h.tenantId, opportunityId: h.dealId!, providerPaymentId: h.providerPaymentId, programId: h.programId,
      closerId: h.closerId, approverId: h.adminId, recordedAt: FIXTURE_PAID_AT,
    };
    await expect(h.t.run((ctx) => seedProviderWin(ctx, args))).rejects.toMatchObject({
      data: { code: "provider_payment.excluded_wrong_match" },
    });
    expect((await read(h)).payment.excludedOpportunityIds).toEqual([h.dealId, otherDeal]);
    await h.t.run((ctx) => seedProviderWin(ctx, { ...args, restoreExcludedOpportunity: true }));
    expect((await read(h)).payment.excludedOpportunityIds).toEqual([otherDeal]);
  });
});

describe("readActiveAllocation", () => {
  it("returns null with no pointer", async () => {
    const h = await providerPaymentFixture({ dealPosition: "booked" });
    const { payment } = await read(h);
    expect(await h.t.run((ctx) => readActiveAllocation(ctx, payment))).toBeNull();
  });

  it.each([
    ["the row cites another payment", { providerPaymentId: undefined }],
    ["the row no longer counts", { status: "disputed" as const }],
  ])("throws when %s", async (_label, patch) => {
    const h = await wonFromWhop();
    await h.t.run(async (ctx) => { await ctx.db.patch("paymentRecords", h.paymentRecordId, patch); });
    const { payment } = await read(h);
    await expect(h.t.run((ctx) => readActiveAllocation(ctx, payment))).rejects.toThrow("broken allocation");
  });

  it("throws when the payment's review state doesn't match its pointer", async () => {
    const h = await wonFromWhop();
    await h.t.run(async (ctx) => { await ctx.db.patch("providerPayments", h.providerPaymentId, { reviewState: "needs_person" }); });
    const { payment } = await read(h);
    await expect(h.t.run((ctx) => readActiveAllocation(ctx, payment))).rejects.toThrow("review state needs_person");
  });
});

describe("clearActiveAllocation with a veto", () => {
  it("records the wrong match, clears both sides of the pointer and keeps the row's provenance", async () => {
    const h = await wonFromWhop();
    await assertPaymentInvariants(h.t, { tenantId: h.tenantId });

    await h.t.run((ctx) => seedUndoToBooked(ctx, {
      paymentRecordId: h.paymentRecordId, approverId: h.adminId, veto: true, now: FIXTURE_NOW,
    }));

    const { payment, record } = await read(h, h.paymentRecordId);
    expect(payment).toMatchObject({ allocationRevision: 2, excludedOpportunityIds: [h.dealId], reviewState: "needs_person" });
    expect(payment.paymentRecordId).toBeUndefined();
    expect(record).toMatchObject({ status: "disputed", providerPaymentId: h.providerPaymentId });
    await assertPaymentInvariants(h.t, { tenantId: h.tenantId });

    // A redelivery re-runs the matcher. Today's matcher still names the one
    // open deal; honouring the veto, nothing is proposed for it.
    await h.t.run((ctx) => refreshProviderPaymentReview(ctx, h.providerPaymentId));
    const refreshed = (await read(h)).payment;
    expect(refreshed.excludedOpportunityIds).toEqual([h.dealId]);
    expect(proposalHonouringVeto(refreshed)).toBeUndefined();
    await assertPaymentInvariants(h.t, { tenantId: h.tenantId });
  });

  it("doesn't repeat a deal already vetoed", async () => {
    const h = await wonFromWhop();
    await h.t.run(async (ctx) => {
      await ctx.db.patch("providerPayments", h.providerPaymentId, { excludedOpportunityIds: [h.dealId] });
      await clearActiveAllocation(ctx, (await ctx.db.get("paymentRecords", h.paymentRecordId))!, { vetoOpportunityId: h.dealId });
    });
    expect((await read(h)).payment.excludedOpportunityIds).toEqual([h.dealId]);
  });

  it(`refuses a veto past ${EXCLUDED_OPPORTUNITY_LIMIT} deals and writes nothing`, async () => {
    const h = await wonFromWhop();
    await h.t.run(async (ctx) => {
      const others: Id<"opportunities">[] = [];
      for (let index = 0; index < EXCLUDED_OPPORTUNITY_LIMIT; index += 1) {
        others.push(await ctx.db.insert("opportunities", {
          stage: "closed", outcome: "lost", lostReason: "stale", source: "calendly", tenantId: h.tenantId,
          leadId: h.personId, createdAt: index, updatedAt: index,
        }));
      }
      await ctx.db.patch("providerPayments", h.providerPaymentId, { excludedOpportunityIds: others });
    });
    const before = await read(h, h.paymentRecordId);
    await expect(h.t.run(async (ctx) => clearActiveAllocation(
      ctx, (await ctx.db.get("paymentRecords", h.paymentRecordId))!, { vetoOpportunityId: h.dealId },
    ))).rejects.toThrow("taken off too many deals");
    expect(await read(h, h.paymentRecordId)).toEqual(before);
  });

  it("refuses a veto when the row isn't the active allocation", async () => {
    const h = await wonFromWhop();
    await h.t.run(async (ctx) => {
      await clearActiveAllocation(ctx, (await ctx.db.get("paymentRecords", h.paymentRecordId))!);
    });
    await expect(h.t.run(async (ctx) => clearActiveAllocation(
      ctx, (await ctx.db.get("paymentRecords", h.paymentRecordId))!, { vetoOpportunityId: h.dealId },
    ))).rejects.toThrow("not the active allocation");
  });

  it("lets the payment be allocated again at the next revision", async () => {
    const h = await wonFromWhop();
    await h.t.run((ctx) => seedUndoToBooked(ctx, {
      paymentRecordId: h.paymentRecordId, approverId: h.adminId, veto: false, now: FIXTURE_NOW,
    }));
    const secondRow = await h.t.run(async (ctx) => {
      await ctx.db.patch("paymentRecords", h.paymentRecordId, { status: "recorded" });
      return h.paymentRecordId;
    });
    await h.t.run(async (ctx) => setActiveAllocation(ctx, {
      payment: (await ctx.db.get("providerPayments", h.providerPaymentId))!,
      record: (await ctx.db.get("paymentRecords", secondRow))!,
      expectedAllocationRevision: 2, reviewState: "recorded", matchMethod: "person", actorUserId: h.adminId, now: FIXTURE_NOW,
    }));
    expect((await read(h)).payment).toMatchObject({ allocationRevision: 3, paymentRecordId: secondRow, reviewState: "recorded" });
  });
});
