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

// Every payment write path keeps the person's enrollments current, and the
// first one makes the person a customer; no path writes a customer row
// (docs/plans/phase-4-customers.md §4.2, §4.3, §5).

afterEach(() => vi.useRealTimers());

const CALL_LOGGED = Date.parse("2026-10-01T12:40:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

async function events(harness: EnrollmentHarness) {
  return await harness.t.run(async (ctx) =>
    (await ctx.db.query("domainEvents").take(500))
      .filter((event) => event.entityType === "enrollment" || event.eventType === "lead.status_changed")
      .map((event) => ({
        eventType: event.eventType,
        source: event.source,
        actorUserId: event.actorUserId,
        toStatus: event.toStatus,
        reason: event.reason,
        leadId: event.leadId,
        programId: event.metadata ? (JSON.parse(event.metadata) as { programId?: string }).programId : undefined,
      })),
  );
}

async function customerRows(harness: EnrollmentHarness) {
  return await harness.t.run((ctx) => ctx.db.query("customers").take(10));
}

async function leadOf(harness: EnrollmentHarness, leadId: Id<"leads">) {
  return (await harness.t.run((ctx) => ctx.db.get("leads", leadId)))!;
}

async function counters(harness: EnrollmentHarness) {
  return await harness.t.run(async (ctx) => {
    const stats = await ctx.db.query("tenantStats").first();
    return { totalLeads: stats?.totalLeads, totalCustomers: stats?.totalCustomers };
  });
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
    // A deal payment, with no customer link.
    expect(payment?.customerId).toBeUndefined();
    expect(payment?.contextType).toBeUndefined();
    expect(await customerRows(harness)).toEqual([]);
    expect((await leadOf(harness, leadId)).status).toBe("converted");
    expect(await events(harness)).toEqual([
      {
        eventType: "enrollment.created", source: "closer", actorUserId: harness.closerId, toStatus: undefined,
        reason: undefined, leadId, programId: programA,
      },
      {
        eventType: "lead.status_changed", source: "closer", actorUserId: harness.closerId, toStatus: "converted",
        reason: "enrolled", leadId, programId: undefined,
      },
    ]);
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
    expect((await leadOf(harness, leadId)).status).toBe("converted");
    expect(await customerRows(harness)).toEqual([]);
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
    // One conversion, and one enrollment.created per program.
    expect((await events(harness)).map(({ eventType, programId }) => [eventType, programId])).toEqual([
      ["enrollment.created", programA],
      ["lead.status_changed", undefined],
      ["enrollment.created", programB],
    ]);
    expect(await customerRows(harness)).toEqual([]);
  });

  it("a side deal payment makes a person with no email a customer", async () => {
    const harness = await enrollmentHarness();
    const { programA } = await programs(harness);
    const leadId = await harness.t.run(async (ctx) => {
      const leadId = await ctx.db.insert("leads", {
        tenantId: harness.tenantId,
        fullName: "No Email",
        phone: "+15555550123",
        status: "active",
        firstSeenAt: 0,
        updatedAt: 0,
        lifecycleStage: "qualified",
        lifecycleStageEnteredAt: { qualified: 0 },
        disposition: "open",
      });
      await ctx.db.insert("tenantStats", {
        tenantId: harness.tenantId,
        totalTeamMembers: 0, totalClosers: 0, totalOpportunities: 0, activeOpportunities: 0, wonDeals: 0, lostDeals: 0,
        totalRevenueMinor: 0, totalPaymentRecords: 0, totalLeads: 3, totalCustomers: 1, lastUpdatedAt: 0,
      });
      return leadId;
    });
    const created = await sideDeal(harness, "no-email", leadId);
    const paidAt = Date.parse("2026-10-05T10:00:00Z");

    await paySideDeal(harness, created.opportunityId, programA, paidAt);

    expect(await leadOf(harness, leadId)).toMatchObject({ status: "converted", lifecycleStage: "customer" });
    expect(await enrollmentsOf(harness, leadId)).toMatchObject([
      { programId: programA, opportunityId: created.opportunityId, enrolledAt: paidAt, status: "active" },
    ]);
    expect(await counters(harness)).toMatchObject({ totalCustomers: 2 });
    expect(await customerRows(harness)).toEqual([]);
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
    // A program still paid for keeps the person a customer; the emptied one
    // is removed by the admin who voided.
    expect((await leadOf(harness, first.leadId)).status).toBe("converted");
    expect((await events(harness)).slice(-1)).toEqual([
      {
        eventType: "enrollment.removed", source: "admin", actorUserId: harness.adminId, toStatus: undefined,
        reason: "no_payment", leadId: first.leadId, programId: programB,
      },
    ]);
  });

  it("remove a person's only enrollment with their only payment", async () => {
    const harness = await enrollmentHarness();
    const { programA } = await programs(harness);
    const created = await sideDeal(harness, "only", { email: "buyer@example.com" });
    const paymentId = await paySideDeal(harness, created.opportunityId, programA, Date.now());
    expect(await enrollmentsOf(harness, created.leadId)).toHaveLength(1);

    const before = await counters(harness);

    await harness.admin.mutation(api.sideDeals.voidPayment.voidPayment, { paymentId, reason: "Wrong person" });

    expect(await enrollmentsOf(harness, created.leadId)).toEqual([]);
    const lead = await leadOf(harness, created.leadId);
    expect(lead.status).toBe("active");
    // The stage follows what is left: the side deal's Showed (§4.3).
    expect(lead.lifecycleStage).toBe("showed");
    expect(await counters(harness)).toEqual({
      totalLeads: before.totalLeads! + 1,
      totalCustomers: before.totalCustomers! - 1,
    });
    expect((await events(harness)).slice(-2).map(({ eventType, reason, toStatus }) => [eventType, reason, toStatus])).toEqual([
      ["enrollment.removed", "no_payment", undefined],
      ["lead.status_changed", "no_enrollment", "active"],
    ]);
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
    const [enrolled] = await enrollmentsOf(harness, created.leadId);
    await harness.admin.mutation(api.enrollments.mutations.updateEnrollmentStatus, {
      enrollmentId: enrolled._id, status: "paused", expectedStatus: "active",
    });
    const [before] = await enrollmentsOf(harness, created.leadId);
    const eventsBefore = await events(harness);

    await harness.admin.mutation(api.billing.mutations.correctPayment, {
      paymentRecordId: paymentId, programId: programB, reason: "Logged under the wrong program",
    });

    expect(await enrollmentsOf(harness, created.leadId)).toEqual([{ ...before, programId: programB }]);
    expect(before.status).toBe("paused");
    // A repoint is neither a removal nor a new enrollment, and the person stays a customer.
    expect(await events(harness)).toEqual(eventsBefore);
    expect((await leadOf(harness, created.leadId)).status).toBe("converted");
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
