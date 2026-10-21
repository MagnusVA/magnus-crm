import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  book,
  enrollmentHarness,
  paySideDeal,
  sideDeal,
  twoPrograms as programs,
  type EnrollmentHarness,
} from "../../tests/enrollmentFixtures";

// The search row reads the enrollments and payments, so every payment write
// leaves it current after syncPersonEnrollments (docs/plans/phase-4-customers.md §6.1).

afterEach(() => vi.useRealTimers());

const CALL_LOGGED = Date.parse("2026-10-01T12:40:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

async function searchRowOf(harness: EnrollmentHarness, leadId: Id<"leads">) {
  return await harness.t.run((ctx) =>
    ctx.db
      .query("leadCustomerSearchRows")
      .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", harness.tenantId).eq("leadId", leadId))
      .unique(),
  );
}

describe("the search row after a payment write", () => {
  it("shows a person who pays on a meeting as a customer, with the total", async () => {
    const harness = await enrollmentHarness();
    const { programA } = await programs(harness);
    const { opportunityId, meetingId, leadId } = await book(harness, "held");
    vi.setSystemTime(new Date(CALL_LOGGED));

    await harness.closer.mutation(api.closer.payments.logPayment, {
      opportunityId, meetingId, amount: 1000, currency: "USD", programId: programA, paymentType: "pif",
    });

    expect(await searchRowOf(harness, leadId)).toMatchObject({
      leadStatus: "converted",
      lifecycle: "customer",
      customerStatus: "active",
      totalPaidMinor: 100_000,
      paymentCurrency: "USD",
      convertedAt: CALL_LOGGED,
    });
  });

  it("adds an additional payment for the same program to the total", async () => {
    const harness = await enrollmentHarness();
    const { programA } = await programs(harness);
    const created = await sideDeal(harness, "again", { email: "buyer@example.com" });
    await paySideDeal(harness, created.opportunityId, programA, CALL_LOGGED);
    vi.setSystemTime(new Date(CALL_LOGGED + DAY_MS));

    await harness.closer.mutation(api.closer.additionalPayment.recordAdditionalPayment, {
      opportunityId: created.opportunityId, amount: 200, currency: "USD", paymentType: "split",
    });

    expect(await searchRowOf(harness, created.leadId)).toMatchObject({
      lifecycle: "customer",
      totalPaidMinor: 70_000,
      convertedAt: CALL_LOGGED,
    });
  });

  it("shows a person whose only payment is voided as a lead again", async () => {
    const harness = await enrollmentHarness();
    const { programA } = await programs(harness);
    const created = await sideDeal(harness, "voided", { email: "buyer@example.com" });
    const paymentId = await paySideDeal(harness, created.opportunityId, programA, CALL_LOGGED);

    await harness.admin.mutation(api.sideDeals.voidPayment.voidPayment, { paymentId, reason: "Wrong person" });

    const row = await searchRowOf(harness, created.leadId);
    expect(row?.lifecycle).not.toBe("customer");
    expect(row?.leadStatus).toBe("active");
    expect(row?.customerStatus).toBeUndefined();
  });

  it("follows an amount correction in billing", async () => {
    const harness = await enrollmentHarness();
    await harness.t.run((ctx) => ctx.db.patch("tenants", harness.tenantId, { billingOpsEnabled: true }));
    const { programA } = await programs(harness);
    const created = await sideDeal(harness, "corrected", { email: "buyer@example.com" });
    const paymentId = await paySideDeal(harness, created.opportunityId, programA, CALL_LOGGED);

    await harness.admin.mutation(api.billing.mutations.correctPayment, {
      paymentRecordId: paymentId, amount: 450, reason: "Amount typo",
    });

    expect(await searchRowOf(harness, created.leadId)).toMatchObject({
      lifecycle: "customer",
      totalPaidMinor: 45_000,
    });
  });
});
