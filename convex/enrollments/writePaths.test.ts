import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  book,
  enrollmentHarness,
  enrollmentsOf,
  paySideDeal,
  sideDeal,
  twoPrograms as programs,
  type EnrollmentHarness,
} from "../../tests/enrollmentFixtures";

// Every payment write path keeps the person's enrollments current beside the
// customer row (docs/plans/phase-4-customers.md §5, PR 1 column). None of
// them emits an enrollment event yet.

afterEach(() => vi.useRealTimers());

const CALL_LOGGED = Date.parse("2026-10-01T12:40:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

async function enrollmentEvents(harness: EnrollmentHarness) {
  return await harness.t.run(async (ctx) =>
    (await ctx.db.query("domainEvents").take(500)).filter((event) => event.entityType === "enrollment"),
  );
}

async function customerOf(harness: EnrollmentHarness, leadId: Id<"leads">) {
  return await harness.t.run((ctx) =>
    ctx.db
      .query("customers")
      .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", harness.tenantId).eq("leadId", leadId))
      .first(),
  );
}

describe("enrollments beside each payment", () => {
  it("a closer's payment on a meeting enrolls the person in its program", async () => {
    const harness = await enrollmentHarness();
    const { programA } = await programs(harness);
    const { opportunityId, meetingId, leadId } = await book(harness, "held");
    vi.setSystemTime(new Date(CALL_LOGGED));

    const paymentId = await harness.closer.mutation(api.closer.payments.logPayment, {
      opportunityId, meetingId, amount: 1000, currency: "USD", programId: programA, paymentType: "pif",
    });

    const enrollments = await enrollmentsOf(harness, leadId);
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0]).toMatchObject({
      programId: programA, opportunityId, enrolledAt: CALL_LOGGED, status: "active", createdAt: CALL_LOGGED,
    });
    const payment = await harness.t.run((ctx) => ctx.db.get("paymentRecords", paymentId));
    expect(payment?.recordedAt).toBe(CALL_LOGGED);
    // The customer row is still written, and agrees.
    expect(await customerOf(harness, leadId)).toMatchObject({ programId: programA, convertedAt: CALL_LOGGED });
    expect(await enrollmentEvents(harness)).toEqual([]);
  });

  it("a reminder payment enrolls the person", async () => {
    const harness = await enrollmentHarness();
    const { programA } = await programs(harness);
    const { opportunityId, leadId } = await book(harness, "reminded");
    const followUpId = await harness.t.run((ctx) =>
      ctx.db.insert("followUps", {
        tenantId: harness.tenantId,
        opportunityId,
        leadId,
        closerId: harness.closerId,
        type: "manual_reminder",
        reason: "closer_initiated",
        status: "pending",
        createdAt: Date.now(),
      }),
    );
    vi.setSystemTime(new Date(CALL_LOGGED));

    await harness.closer.mutation(api.closer.reminderOutcomes.logReminderPayment, {
      followUpId, amount: 100, currency: "USD", programId: programA, paymentType: "deposit",
    });

    expect(await enrollmentsOf(harness, leadId)).toMatchObject([
      { programId: programA, opportunityId, enrolledAt: CALL_LOGGED, status: "active" },
    ]);
  });

  it("an additional payment joins the enrollment, and a side deal for a second program adds one", async () => {
    const harness = await enrollmentHarness();
    const { programA, programB } = await programs(harness);
    const { opportunityId, meetingId, leadId } = await book(harness, "two-programs");
    vi.setSystemTime(new Date(CALL_LOGGED));
    await harness.closer.mutation(api.closer.payments.logPayment, {
      opportunityId, meetingId, amount: 1000, currency: "USD", programId: programA, paymentType: "deposit",
    });
    const [enrolledA] = await enrollmentsOf(harness, leadId);

    vi.setSystemTime(new Date(CALL_LOGGED + DAY_MS));
    await harness.closer.mutation(api.closer.additionalPayment.recordAdditionalPayment, {
      opportunityId, amount: 500, currency: "USD", paymentType: "split",
    });
    expect(await enrollmentsOf(harness, leadId)).toEqual([enrolledA]);

    const second = await sideDeal(harness, "second-program", leadId);
    await paySideDeal(harness, second.opportunityId, programB, CALL_LOGGED + 2 * DAY_MS);
    // A third deal for the program the person already has adds nothing.
    const third = await sideDeal(harness, "renewal", leadId);
    await paySideDeal(harness, third.opportunityId, programA, CALL_LOGGED + 3 * DAY_MS);

    const enrollments = await enrollmentsOf(harness, leadId);
    expect(enrollments).toEqual([
      enrolledA,
      expect.objectContaining({
        programId: programB, opportunityId: second.opportunityId, enrolledAt: CALL_LOGGED + 2 * DAY_MS, status: "active",
      }),
    ]);
    expect(await enrollmentEvents(harness)).toEqual([]);
  });

  it("a customer payment, which has no deal, adds no enrollment", async () => {
    const harness = await enrollmentHarness();
    const { programA, programB } = await programs(harness);
    const created = await sideDeal(harness, "customer-payment", { email: "buyer@example.com" });
    await paySideDeal(harness, created.opportunityId, programA, Date.now());
    const customer = (await customerOf(harness, created.leadId))!;

    await harness.admin.mutation(api.customers.mutations.recordCustomerPayment, {
      customerId: customer._id, amount: 50, currency: "USD", programId: programB, paymentType: "pif",
    });

    expect((await enrollmentsOf(harness, created.leadId)).map((row) => row.programId)).toEqual([programA]);
  });
});

describe("voided side deal payments", () => {
  it("remove the enrollment the payment alone held, and the earliest payment left takes over", async () => {
    const harness = await enrollmentHarness();
    const { programA, programB } = await programs(harness);
    const start = Date.parse("2026-10-05T10:00:00Z");
    const first = await sideDeal(harness, "first", { email: "buyer@example.com" });
    const firstPayment = await paySideDeal(harness, first.opportunityId, programA, start);
    const second = await sideDeal(harness, "second", first.leadId);
    await paySideDeal(harness, second.opportunityId, programA, start + DAY_MS);
    const third = await sideDeal(harness, "third", first.leadId);
    const thirdPayment = await paySideDeal(harness, third.opportunityId, programB, start + 2 * DAY_MS);
    const [enrolledA] = await enrollmentsOf(harness, first.leadId);
    expect(enrolledA).toMatchObject({ programId: programA, opportunityId: first.opportunityId, enrolledAt: start });

    await harness.admin.mutation(api.sideDeals.voidPayment.voidPayment, { paymentId: firstPayment, reason: "Wrong deal" });
    expect(await enrollmentsOf(harness, first.leadId)).toEqual([
      { ...enrolledA, opportunityId: second.opportunityId, enrolledAt: start + DAY_MS },
      expect.objectContaining({ programId: programB }),
    ]);

    await harness.admin.mutation(api.sideDeals.voidPayment.voidPayment, { paymentId: thirdPayment, reason: "Refunded" });
    expect((await enrollmentsOf(harness, first.leadId)).map((row) => row.programId)).toEqual([programA]);
    expect(await enrollmentEvents(harness)).toEqual([]);
  });

  it("remove a person's only enrollment with their only payment", async () => {
    const harness = await enrollmentHarness();
    const { programA } = await programs(harness);
    const created = await sideDeal(harness, "only", { email: "buyer@example.com" });
    const paymentId = await paySideDeal(harness, created.opportunityId, programA, Date.now());
    expect(await enrollmentsOf(harness, created.leadId)).toHaveLength(1);

    await harness.admin.mutation(api.sideDeals.voidPayment.voidPayment, { paymentId, reason: "Wrong person" });

    expect(await enrollmentsOf(harness, created.leadId)).toEqual([]);
    const lead = await harness.t.run((ctx) => ctx.db.get("leads", created.leadId));
    expect(lead?.status).toBe("active");
  });
});

describe("billing corrections", () => {
  async function billingTenant(harness: EnrollmentHarness) {
    await harness.t.run((ctx) => ctx.db.patch("tenants", harness.tenantId, { billingOpsEnabled: true }));
  }

  it("repoint the enrollment when its only payment changes program, keeping its ID and status (D13)", async () => {
    const harness = await enrollmentHarness();
    await billingTenant(harness);
    const { programA, programB } = await programs(harness);
    const created = await sideDeal(harness, "corrected", { email: "buyer@example.com" });
    const paymentId = await paySideDeal(harness, created.opportunityId, programA, Date.now());
    const customer = (await customerOf(harness, created.leadId))!;
    await harness.admin.mutation(api.customers.mutations.updateCustomerStatus, { customerId: customer._id, status: "paused" });
    const [before] = await enrollmentsOf(harness, created.leadId);

    await harness.admin.mutation(api.billing.mutations.correctPayment, {
      paymentRecordId: paymentId, programId: programB, reason: "Logged under the wrong program",
    });

    expect(await enrollmentsOf(harness, created.leadId)).toEqual([{ ...before, programId: programB }]);
    expect(before.status).toBe("paused");
  });

  it("add an enrollment when a later payment moves to a new program, and leave it alone on an amount fix", async () => {
    const harness = await enrollmentHarness();
    await billingTenant(harness);
    const { programA, programB } = await programs(harness);
    const created = await sideDeal(harness, "split", { email: "buyer@example.com" });
    const start = Date.parse("2026-10-05T10:00:00Z");
    const firstPayment = await paySideDeal(harness, created.opportunityId, programA, start);
    vi.setSystemTime(new Date(start + DAY_MS));
    const { paymentId: laterPayment } = await harness.closer.mutation(api.closer.additionalPayment.recordAdditionalPayment, {
      opportunityId: created.opportunityId, amount: 200, currency: "USD", paymentType: "split",
    });

    await harness.admin.mutation(api.billing.mutations.correctPayment, {
      paymentRecordId: laterPayment, programId: programB, reason: "Second program",
    });
    const enrollments = await enrollmentsOf(harness, created.leadId);
    expect(enrollments).toMatchObject([
      { programId: programA, opportunityId: created.opportunityId, enrolledAt: start },
      { programId: programB, opportunityId: created.opportunityId, enrolledAt: start + DAY_MS },
    ]);

    await harness.admin.mutation(api.billing.mutations.correctPayment, {
      paymentRecordId: firstPayment, amount: 450, reason: "Amount typo",
    });
    expect(await enrollmentsOf(harness, created.leadId)).toEqual(enrollments);
  });
});

describe("customer status", () => {
  it("sets the status of the enrollment for the customer's program", async () => {
    const harness = await enrollmentHarness();
    const { programA, programB } = await programs(harness);
    const created = await sideDeal(harness, "status", { email: "buyer@example.com" });
    await paySideDeal(harness, created.opportunityId, programA, Date.parse("2026-10-05T10:00:00Z"));
    const second = await sideDeal(harness, "status-second", created.leadId);
    await paySideDeal(harness, second.opportunityId, programB, Date.parse("2026-10-06T10:00:00Z"));
    const customer = (await customerOf(harness, created.leadId))!;
    const changedAt = Date.parse("2026-10-07T10:00:00Z");
    vi.setSystemTime(new Date(changedAt));

    await harness.admin.mutation(api.customers.mutations.updateCustomerStatus, { customerId: customer._id, status: "churned" });

    const enrollments = await enrollmentsOf(harness, created.leadId);
    expect(enrollments).toMatchObject([
      { programId: programA, status: "churned", statusChangedAt: changedAt, statusChangedByUserId: harness.adminId },
      { programId: programB, status: "active" },
    ]);
    expect(enrollments[1].statusChangedAt).toBeUndefined();

    vi.setSystemTime(new Date(changedAt + DAY_MS));
    await harness.admin.mutation(api.customers.mutations.updateCustomerStatus, { customerId: customer._id, status: "active" });
    expect((await enrollmentsOf(harness, created.leadId))[0]).toMatchObject({
      status: "active", statusChangedAt: changedAt + DAY_MS, statusChangedByUserId: harness.adminId,
    });
  });
});
