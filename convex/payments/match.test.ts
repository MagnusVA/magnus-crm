import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertDealTask, insertOtherTenant } from "../../tests/dealStateFixtures";
import { insertPayment, insertProgram } from "../../tests/enrollmentFixtures";
import {
  FIXTURE_NOW,
  FIXTURE_PAID_AT,
  PAYER_EMAIL,
  PRODUCT_ID,
  insertProviderBinding,
  insertProviderDeal,
  insertProviderFact,
  insertProviderIdentifier,
  insertProviderPerson,
  providerPaymentFixture,
} from "../../tests/providerPaymentFixtures";
import type { Doc } from "../_generated/dataModel";
import { findPaymentTarget, refreshProviderPaymentReview } from "./match";

type Fixture = Awaited<ReturnType<typeof providerPaymentFixture>>;

function match(fixture: Fixture) {
  return fixture.t.run(async (ctx) =>
    findPaymentTarget(ctx, (await ctx.db.get("providerPayments", fixture.providerPaymentId))!));
}

function refresh(fixture: Fixture) {
  return fixture.t.run(async (ctx) => {
    await refreshProviderPaymentReview(ctx, fixture.providerPaymentId);
    return (await ctx.db.get("providerPayments", fixture.providerPaymentId))!;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => vi.useRealTimers());

describe("provider payment matching", () => {
  it("finds one Booked deal before its meeting without writing", async () => {
    const fixture = await providerPaymentFixture({ fact: { payerEmail: " River@Example.com " } });
    const readRows = () => fixture.t.run(async (ctx) => ({
      provider: await ctx.db.get("providerPayments", fixture.providerPaymentId),
      person: await ctx.db.get("leads", fixture.personId),
      identifiers: await ctx.db.query("leadIdentifiers").take(10),
      deal: await ctx.db.get("opportunities", fixture.dealId!),
    }));
    const before = await readRows();
    expect(await match(fixture)).toEqual({
      kind: "ready", leadId: fixture.personId, opportunityId: fixture.dealId, matchMethod: "email_one_open_deal",
    });
    expect(await readRows()).toEqual(before);
  });

  it("finds a single Follow-up deal with a reschedule link", async () => {
    const fixture = await providerPaymentFixture({ dealPosition: "follow_up" });
    await fixture.t.run((ctx) => insertDealTask(ctx, fixture.dealId!));
    expect(await match(fixture)).toMatchObject({ kind: "ready", opportunityId: fixture.dealId });
  });

  it("counts Qualified among open deals and presents candidates by latest meeting", async () => {
    const fixture = await providerPaymentFixture();
    const [qualified, newer] = await fixture.t.run(async (ctx) => [
      await insertProviderDeal(ctx, { tenantId: fixture.tenantId, leadId: fixture.personId, position: "qualified" }),
      await insertProviderDeal(ctx, {
        tenantId: fixture.tenantId, leadId: fixture.personId,
        position: "follow_up", latestMeetingAt: FIXTURE_NOW + 1000,
      }),
    ]);
    expect(await match(fixture)).toEqual({
      kind: "needs_person",
      reason: "several_open_deals",
      candidateLeadId: fixture.personId,
      candidateOpportunityIds: [newer, fixture.dealId, qualified],
    });
  });

  it.each([
    { dealPosition: null, reason: "no_open_deal" },
    { dealPosition: "qualified", reason: "qualified_only" },
    { dealPosition: "won", reason: "won_deal_no_membership" },
    { dealPosition: "lost", reason: "lost_by_person" },
    { dealPosition: "lost", lostReason: "no_show", reason: "system_loss" },
    { dealPosition: "lost", lostReason: "canceled", reason: "system_loss" },
  ] as const)("classifies $reason when it is the person's only deal", async ({ dealPosition, lostReason, reason }) => {
    const fixture = await providerPaymentFixture({ dealPosition, lostReason });
    if (reason === "lost_by_person") {
      await fixture.t.run((ctx) => ctx.db.patch("opportunities", fixture.dealId!, {
        lostReason: "no_show", lostByUserId: fixture.adminId,
      }));
    }
    expect(await match(fixture)).toMatchObject({
      kind: "needs_person", reason, candidateLeadId: fixture.personId,
      candidateOpportunityIds: fixture.dealId ? [fixture.dealId] : [],
    });
  });

  it("holds a side deal", async () => {
    const fixture = await providerPaymentFixture({ source: "side_deal" });
    expect(await match(fixture)).toMatchObject({ reason: "side_deal" });
  });

  it("recognizes an expired Slack qualification as a system loss", async () => {
    const fixture = await providerPaymentFixture({ dealPosition: "lost", source: "slack_qualified" });
    await fixture.t.run((ctx) => ctx.db.patch("opportunities", fixture.dealId!, { lostReason: "stale" }));
    expect(await match(fixture)).toMatchObject({ reason: "system_loss" });
  });

  it("bounds candidate display without allowing an overflow to choose a deal", async () => {
    const fixture = await providerPaymentFixture();
    await fixture.t.run(async (ctx) => {
      const deal = (await ctx.db.get("opportunities", fixture.dealId!))!;
      const { _id, _creationTime, ...fields } = deal;
      expect(_id).toBe(fixture.dealId);
      expect(_creationTime).toBeDefined();
      for (let index = 0; index < 101; index++) {
        await ctx.db.insert("opportunities", { ...fields, latestMeetingAt: FIXTURE_PAID_AT + index });
      }
    });
    const result = await match(fixture);
    expect(result).toMatchObject({ reason: "several_open_deals" });
    expect(result.kind === "needs_person" && result.candidateOpportunityIds.length).toBe(20);
  });

  it.each([
    ["partner@example.com", "unknown_payer"],
    [undefined, "no_payer_email"],
    ["email@example.com", "no_payer_email"],
  ] as const)("holds unknown, absent and placeholder email %s", async (payerEmail, reason) => {
    const fixture = await providerPaymentFixture({ fact: { payerEmail } });
    if (payerEmail === "email@example.com") {
      await fixture.t.run((ctx) => ctx.db.patch("leads", fixture.personId, { email: payerEmail }));
    }
    expect(await match(fixture)).toMatchObject({ kind: "needs_person", reason, candidateOpportunityIds: [] });
  });

  it("combines canonical and non-suggested identifiers across surviving people", async () => {
    const fixture = await providerPaymentFixture();
    const other = await fixture.t.run(async (ctx) => {
      const other = await insertProviderPerson(ctx, fixture.tenantId, { email: "sam@example.com" });
      return insertProviderIdentifier(ctx, fixture.tenantId, other, "email", PAYER_EMAIL, "suggested");
    });
    expect(await match(fixture)).toMatchObject({ kind: "ready", leadId: fixture.personId });
    await fixture.t.run((ctx) => ctx.db.patch("leadIdentifiers", other, { confidence: "inferred" }));
    expect(await match(fixture)).toMatchObject({ reason: "ambiguous_person" });
  });

  it("follows merge chains and deduplicates a canonical email and an alias on the same survivor", async () => {
    const fixture = await providerPaymentFixture({ fact: { payerEmail: "prior@example.com" } });
    await fixture.t.run(async (ctx) => {
      const interim = await insertProviderPerson(ctx, fixture.tenantId, {
        status: "merged", mergedIntoLeadId: fixture.personId, email: "interim@example.com",
      });
      const original = await insertProviderPerson(ctx, fixture.tenantId, {
        status: "merged", mergedIntoLeadId: interim, email: "prior@example.com",
      });
      await insertProviderIdentifier(ctx, fixture.tenantId, original, "email", "prior@example.com");
      await insertProviderIdentifier(ctx, fixture.tenantId, fixture.personId, "email", "prior@example.com");
    });
    expect(await match(fixture)).toMatchObject({ kind: "ready", leadId: fixture.personId });
  });

  it("holds a broken merge chain even when the same key also names an active person", async () => {
    const fixture = await providerPaymentFixture();
    await fixture.t.run((ctx) => insertProviderPerson(ctx, fixture.tenantId, { status: "merged" }));
    expect(await match(fixture)).toMatchObject({ reason: "ambiguous_person" });
  });

  it("holds identity overflow even when the rows read point at one lead", async () => {
    const fixture = await providerPaymentFixture();
    await fixture.t.run(async (ctx) => {
      for (let index = 0; index < 17; index++) {
        await insertProviderIdentifier(ctx, fixture.tenantId, fixture.personId, "email", PAYER_EMAIL);
      }
    });
    expect(await match(fixture)).toMatchObject({ reason: "ambiguous_person" });
  });

  it("does not match a canonical or alternate email that exists only in another tenant", async () => {
    const fixture = await providerPaymentFixture({ fact: { payerEmail: "elsewhere@example.com" } });
    await fixture.t.run(async (ctx) => {
      const otherTenant = await insertOtherTenant(ctx);
      const other = await insertProviderPerson(ctx, otherTenant, { email: "elsewhere@example.com" });
      await insertProviderIdentifier(ctx, otherTenant, other, "email", "elsewhere@example.com");
    });
    expect(await match(fixture)).toEqual({
      kind: "needs_person", reason: "unknown_payer", candidateLeadId: undefined, candidateOpportunityIds: [],
    });
  });

  it("uses an international phone only for a conflict or a phone-only hold", async () => {
    const fixture = await providerPaymentFixture({ fact: { payerPhone: "+1 (202) 555-0142" } });
    await fixture.t.run(async (ctx) => {
      const other = await insertProviderPerson(ctx, fixture.tenantId, { email: "sam@example.com" });
      await insertProviderIdentifier(ctx, fixture.tenantId, other, "phone", "+12025550142");
    });
    expect(await match(fixture)).toMatchObject({ reason: "phone_conflict", candidateLeadId: fixture.personId });
    await fixture.t.run((ctx) => ctx.db.patch("providerPayments", fixture.providerPaymentId, { payerEmail: undefined }));
    expect(await match(fixture)).toMatchObject({ reason: "phone_only" });
    await fixture.t.run((ctx) => ctx.db.patch("providerPayments", fixture.providerPaymentId, { payerPhone: "202-555-0142" }));
    expect(await match(fixture)).toMatchObject({ reason: "no_payer_email" });
  });

  const evidenceCases = [
    ["multi_item", { lineItemCount: 2 }],
    ["unmapped_product", { productId: "prod_unmapped" }],
    ["unmapped_product", { variantId: "plan_unmapped" }],
    ["financing", { financingInstallmentsCount: 2 }],
    ["financing", { paymentMethodType: "klarna" }],
    ["renewal_unbound", { billingReason: "subscription_cycle" }],
    ["renewal_unbound", { billingReason: "subscription_update" }],
    ["unknown_billing_reason", { billingReason: "subscription" }],
    ["unknown_billing_reason", { billingReason: "new_reason" }],
    ["unknown_billing_reason", { billingReason: undefined }],
    ["stale_payment", { paidAt: FIXTURE_NOW - 8 * 86_400_000 }],
    ["unsupported_currency", { totalMinor: undefined, currency: "JPY", decimals: 0 }],
    ["refund", { adverseState: "partially_refunded", refundedMinor: 1000 }],
    ["refund", { adverseState: "refund_pending", adverseFencedAt: FIXTURE_NOW }],
    ["dispute", { adverseState: "dispute_open" }],
  ] as const satisfies ReadonlyArray<[string, Partial<Doc<"providerPayments">>]>;
  it.each(evidenceCases)("holds %s", async (reason, fact) => {
    const fixture = await providerPaymentFixture({ fact });
    if (reason === "stale_payment") {
      await fixture.t.run((ctx) => ctx.db.patch("opportunities", fixture.dealId!, { createdAt: FIXTURE_NOW - 9 * 86_400_000 }));
    }
    expect(await match(fixture)).toMatchObject({ kind: "needs_person", reason, candidateLeadId: fixture.personId });
  });

  it("applies the deal-time cutoff before age or product checks", async () => {
    const fixture = await providerPaymentFixture({ fact: { paidAt: FIXTURE_NOW - 8 * 86_400_000, productId: undefined } });
    expect(await match(fixture)).toMatchObject({ reason: "deal_newer_than_payment" });
  });

  it("holds a payment older than the connection import cutoff", async () => {
    const fixture = await providerPaymentFixture();
    await fixture.t.run((ctx) => ctx.db.patch("tenantPaymentConnections", fixture.connectionId, { autoImportAfter: FIXTURE_PAID_AT + 1 }));
    expect(await match(fixture)).toMatchObject({ reason: "stale_payment" });
  });

  it("reads the current product and variant mapping after earlier versions have been disabled", async () => {
    const fixture = await providerPaymentFixture();
    await fixture.t.run(async (ctx) => {
      const previous = (await ctx.db.get("paymentProviderBindings", fixture.variantBindingId))!;
      await ctx.db.patch("paymentProviderBindings", previous._id, { enabled: false, disabledReason: "removed" });
      await insertProviderBinding(ctx, {
        ...fixture,
        externalId: previous.externalId,
        binding: { kind: "variant_type", paymentType: "monthly" },
      });
    });
    expect(await match(fixture)).toMatchObject({ kind: "ready" });
  });

  it("holds another unbound paid membership under a different known email", async () => {
    const fixture = await providerPaymentFixture();
    await fixture.t.run(async (ctx) => {
      await insertProviderIdentifier(ctx, fixture.tenantId, fixture.personId, "email", "alias@example.com");
      await insertProviderFact(ctx, fixture.tenantId, fixture.connectionId, {
        externalPaymentId: "pay_earlier", payerEmail: "alias@example.com", membershipId: "mem_unbound",
      });
    });
    expect(await match(fixture)).toMatchObject({ reason: "unbound_membership" });
  });

  it("checks counting manual payments before the closer condition", async () => {
    const fixture = await providerPaymentFixture();
    const record = await fixture.t.run(async (ctx) => {
      await ctx.db.patch("opportunities", fixture.dealId!, { assignedCloserId: undefined });
      return await insertPayment(ctx, { ...fixture, opportunityId: fixture.dealId!, recordedAt: 1 });
    });
    expect(await match(fixture)).toMatchObject({ reason: "unlinked_manual_payment" });
    await fixture.t.run((ctx) => ctx.db.patch("paymentRecords", record, { status: "disputed" }));
    expect(await match(fixture)).toMatchObject({ reason: "no_closer" });
  });
});

describe("binding precedence and persisted review", () => {
  it("returns stored resolution as-is ahead of current matching checks", async () => {
    const fixture = await providerPaymentFixture({ fact: { payerEmail: undefined, reviewState: "linked" } });
    const record = await fixture.t.run(async (ctx) => {
      const record = await insertPayment(ctx, { ...fixture, opportunityId: fixture.dealId!, recordedAt: 1 });
      await ctx.db.patch("providerPayments", fixture.providerPaymentId, {
        paymentRecordId: record, opportunityId: fixture.dealId, leadId: fixture.personId, matchMethod: "person",
      });
      return record;
    });
    expect(await match(fixture)).toEqual({
      kind: "resolved", paymentRecordId: record, opportunityId: fixture.dealId, leadId: fixture.personId, matchMethod: "person",
    });
    expect(await refresh(fixture)).toMatchObject({ reviewState: "linked", paymentRecordId: record });
  });

  it("prioritizes a trusted checkout binding and invalidates it when its deal moves to another person", async () => {
    const fixture = await providerPaymentFixture({ fact: { checkoutConfigurationId: "ch_fixture", payerEmail: undefined } });
    await fixture.t.run((ctx) => insertProviderBinding(ctx, {
      ...fixture, externalId: "ch_fixture",
      binding: { kind: "checkout_deal", leadId: fixture.personId, opportunityId: fixture.dealId! },
    }));
    expect(await match(fixture)).toMatchObject({ kind: "ready", matchMethod: "checkout_binding", leadId: fixture.personId });
    await fixture.t.run(async (ctx) => {
      const newLead = await insertProviderPerson(ctx, fixture.tenantId, { email: "another@example.com" });
      await ctx.db.patch("opportunities", fixture.dealId!, { leadId: newLead });
    });
    expect(await match(fixture)).toMatchObject({ reason: "no_payer_email" });
  });

  it("uses a valid membership anchor on a won deal before the person's new deal and rejects a disputed anchor", async () => {
    const fixture = await providerPaymentFixture({
      dealPosition: "won",
      fact: { membershipId: "mem_fixture", checkoutConfigurationId: "ch_fixture", billingReason: "subscription_update" },
    });
    const anchor = await fixture.t.run(async (ctx) => {
      await ctx.db.patch("opportunities", fixture.dealId!, { soldProgramId: fixture.programId });
      await ctx.db.patch("paymentProviderBindings", fixture.productBindingId, { enabled: false });
      await ctx.db.patch("paymentProviderBindings", fixture.variantBindingId, { enabled: false });
      await insertProviderFact(ctx, fixture.tenantId, fixture.connectionId, {
        externalPaymentId: "pay_other_membership", membershipId: "mem_unbound",
      });
      const newDeal = await insertProviderDeal(ctx, { ...fixture, leadId: fixture.personId, assignedCloserId: fixture.closerId });
      await insertProviderBinding(ctx, {
        ...fixture, externalId: "ch_fixture",
        binding: { kind: "checkout_deal", leadId: fixture.personId, opportunityId: newDeal },
      });
      const record = await insertPayment(ctx, { ...fixture, opportunityId: fixture.dealId!, recordedAt: 1 });
      const origin = await insertProviderFact(ctx, fixture.tenantId, fixture.connectionId, {
        externalPaymentId: "pay_anchor", membershipId: "mem_fixture", paymentRecordId: record,
        opportunityId: fixture.dealId, leadId: fixture.personId, reviewState: "linked",
      });
      await ctx.db.patch("paymentRecords", record, { providerPaymentId: origin });
      await insertProviderBinding(ctx, {
        ...fixture, externalId: "mem_fixture",
        binding: { kind: "membership_deal", leadId: fixture.personId, opportunityId: fixture.dealId!, anchorPaymentRecordId: record },
      });
      return record;
    });
    expect(await match(fixture)).toMatchObject({
      kind: "ready", matchMethod: "membership_binding", opportunityId: fixture.dealId,
    });
    await fixture.t.run((ctx) => ctx.db.patch("paymentRecords", anchor, { status: "disputed" }));
    expect(await match(fixture)).toMatchObject({ reason: "renewal_unbound" });
  });

  it("updates only changed review decisions and clears a formerly ready deal", async () => {
    const fixture = await providerPaymentFixture();
    const ready = await refresh(fixture);
    expect(ready).toMatchObject({
      reviewState: "needs_person", reviewReason: "ready", candidateLeadId: fixture.personId,
      candidateOpportunityId: fixture.dealId, matchedAt: FIXTURE_NOW,
    });
    vi.setSystemTime(FIXTURE_NOW + 1000);
    expect(await refresh(fixture)).toEqual(ready);
    await fixture.t.run((ctx) => ctx.db.patch("providerPayments", fixture.providerPaymentId, { lineItemCount: 2 }));
    const changed = await refresh(fixture);
    expect(changed).toMatchObject({ reviewReason: "multi_item", matchedAt: FIXTURE_NOW + 1000 });
    expect(changed.candidateOpportunityId).toBeUndefined();
    await fixture.t.run((ctx) => ctx.db.patch("providerPayments", fixture.providerPaymentId, { totalMinor: 0 }));
    const zero = await refresh(fixture);
    expect(zero.reviewState).toBe("not_actionable");
    expect(zero.reviewReason).toBeUndefined();
    expect(zero.matchedAt).toBeUndefined();
  });

  it.each(["historical", "dismissed", "recorded", "linked"] as const)("leaves %s unchanged", async (reviewState) => {
    const fixture = await providerPaymentFixture({ fact: { reviewState } });
    const before = await fixture.t.run((ctx) => ctx.db.get("providerPayments", fixture.providerPaymentId));
    expect(await refresh(fixture)).toEqual(before);
  });
});

it("scopes membership history to the payment's own connection", async () => {
  const fixture = await providerPaymentFixture();
  const { t, tenantId, connectionId, personId } = fixture;
  await t.run(async (ctx) => {
    const source = (await ctx.db.get("tenantPaymentConnections", connectionId))!;
    const { _id, _creationTime, ...fields } = source;
    expect(_id).toBe(connectionId);
    expect(_creationTime).toBeDefined();
    const inactive = await ctx.db.insert("tenantPaymentConnections", {
      ...fields, environment: "live", status: "disconnected",
    });
    await insertProviderFact(ctx, tenantId, inactive, {
      externalPaymentId: "pay_other_environment", membershipId: "mem_other_environment",
      leadId: personId, candidateLeadId: personId,
    });
  });
  expect(await match(fixture)).toMatchObject({ kind: "ready" });
});

it("ignores a conflicting placeholder identifier and a phone saved only on another profile", async () => {
  const fixture = await providerPaymentFixture({ fact: { payerPhone: "+12342342342" } });
  const profileOnlyPhone = "+17789559253";
  await fixture.t.run(async (ctx) => {
    const other = await insertProviderPerson(ctx, fixture.tenantId, {
      email: "different@example.invalid", phone: profileOnlyPhone,
    });
    await insertProviderIdentifier(ctx, fixture.tenantId, other, "phone", "+12342342342");
  });
  expect(await match(fixture)).toMatchObject({ kind: "ready" });
  await fixture.t.run((ctx) => ctx.db.patch("providerPayments", fixture.providerPaymentId, { payerPhone: profileOnlyPhone }));
  expect(await match(fixture)).toMatchObject({ kind: "ready" });
});

it("holds the next payment at exactly 40 stored rows including disputed ones", async () => {
  const fixture = await providerPaymentFixture();
  const { t, dealId } = fixture;
  await t.run(async (ctx) => {
    for (let index = 0; index < 39; index++) {
      await insertPayment(ctx, { ...fixture, opportunityId: dealId!, recordedAt: index, status: "disputed" });
    }
  });
  expect(await match(fixture)).toMatchObject({ kind: "ready" });
  await t.run((ctx) => insertPayment(ctx, { ...fixture, opportunityId: dealId!, recordedAt: 39, status: "disputed" }));
  expect(await match(fixture)).toMatchObject({ reason: "capacity_hold" });
});

it("reports a binding conflict, a program mismatch, and a membership history read limit separately", async () => {
  const fixture = await providerPaymentFixture();
  const { t, providerPaymentId, tenantId, connectionId, dealId, personId } = fixture;
  const duplicate = await t.run((ctx) => insertProviderBinding(ctx, {
    ...fixture, externalId: PRODUCT_ID, binding: { kind: "product_program", programId: fixture.programId },
  }));
  expect(await match(fixture)).toMatchObject({ reason: "binding_conflict" });
  await t.run(async (ctx) => {
    await ctx.db.delete("paymentProviderBindings", duplicate);
    const anotherProgram = await insertProgram(ctx, tenantId, "Different fixture program");
    await ctx.db.patch("opportunities", dealId!, { soldProgramId: anotherProgram });
    await insertProviderBinding(ctx, {
      ...fixture, externalId: "checkout_fixture", binding: { kind: "checkout_deal", leadId: personId, opportunityId: dealId! },
    });
    await ctx.db.patch("providerPayments", providerPaymentId, { checkoutConfigurationId: "checkout_fixture" });
  });
  expect(await match(fixture)).toMatchObject({ reason: "program_mismatch" });
  await t.run(async (ctx) => {
    await ctx.db.patch("providerPayments", providerPaymentId, { checkoutConfigurationId: undefined });
    for (let index = 0; index < 41; index++) {
      await insertProviderFact(ctx, tenantId, connectionId, { externalPaymentId: `pay_prior_${index}` });
    }
  });
  expect(await match(fixture)).toMatchObject({ reason: "read_limit" });
});

it("labels a mismatch between the provider payment and its connection tenant", async () => {
  const fixture = await providerPaymentFixture();
  await fixture.t.run(async (ctx) => {
    const other = await insertOtherTenant(ctx);
    await ctx.db.patch("tenantPaymentConnections", fixture.connectionId, { tenantId: other });
  });
  expect(await match(fixture)).toMatchObject({ reason: "connection_mismatch" });
});

describe("a deal a person took the payment off", () => {
  it("is never the ready target; when it is the only candidate the reason says so", async () => {
    const fixture = await providerPaymentFixture({ fact: { excludedOpportunityIds: [] } });
    await fixture.t.run((ctx) => ctx.db.patch("providerPayments", fixture.providerPaymentId, {
      excludedOpportunityIds: [fixture.dealId!],
    }));
    expect(await match(fixture)).toEqual({
      kind: "needs_person", reason: "excluded_wrong_match", candidateLeadId: fixture.personId, candidateOpportunityIds: [],
    });
    // A redelivered read stores the same answer and proposes nothing.
    const stored = await refresh(fixture);
    expect(stored).toMatchObject({ reviewState: "needs_person", reviewReason: "excluded_wrong_match", candidateLeadId: fixture.personId });
    expect(stored.candidateOpportunityId).toBeUndefined();
  });

  it("still counts among open deals but is never offered as a candidate", async () => {
    const fixture = await providerPaymentFixture();
    const other = await fixture.t.run(async (ctx) => {
      const other = await insertProviderDeal(ctx, { tenantId: fixture.tenantId, leadId: fixture.personId, position: "follow_up" });
      await ctx.db.patch("providerPayments", fixture.providerPaymentId, { excludedOpportunityIds: [fixture.dealId!] });
      return other;
    });
    expect(await match(fixture)).toEqual({
      kind: "needs_person", reason: "several_open_deals", candidateLeadId: fixture.personId, candidateOpportunityIds: [other],
    });
  });

  it("overrides a checkout binding that names it", async () => {
    const fixture = await providerPaymentFixture();
    await fixture.t.run(async (ctx) => {
      await insertProviderBinding(ctx, {
        ...fixture, externalId: "checkout_fixture",
        binding: { kind: "checkout_deal", leadId: fixture.personId, opportunityId: fixture.dealId! },
      });
      await ctx.db.patch("providerPayments", fixture.providerPaymentId, {
        checkoutConfigurationId: "checkout_fixture", excludedOpportunityIds: [fixture.dealId!],
      });
    });
    expect(await match(fixture)).toMatchObject({ reason: "excluded_wrong_match", candidateOpportunityIds: [] });
  });
});

it("holds a bound payment for a person at 100 deals, the writers' capacity rule", async () => {
  const fixture = await providerPaymentFixture();
  await fixture.t.run(async (ctx) => {
    await insertProviderBinding(ctx, {
      ...fixture, externalId: "checkout_fixture",
      binding: { kind: "checkout_deal", leadId: fixture.personId, opportunityId: fixture.dealId! },
    });
    await ctx.db.patch("providerPayments", fixture.providerPaymentId, { checkoutConfigurationId: "checkout_fixture" });
    for (let index = 0; index < 98; index++) {
      await insertProviderDeal(ctx, { tenantId: fixture.tenantId, leadId: fixture.personId, position: "lost" });
    }
  });
  expect(await match(fixture)).toMatchObject({ kind: "ready" });
  await fixture.t.run((ctx) => insertProviderDeal(ctx, { tenantId: fixture.tenantId, leadId: fixture.personId, position: "lost" }));
  expect(await match(fixture)).toMatchObject({ reason: "capacity_hold" });
});
