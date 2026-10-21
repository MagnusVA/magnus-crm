/**
 * The person page reads the person's enrollments, not the customer row
 * (docs/plans/phase-4-customers.md §6.2): each program's status, deal and
 * what it has paid, and the person's status, total and "Customer since".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness } from "../../tests/bookingHarness";
import { ENROLLED_AT, seedEnrolledCustomer } from "../../tests/enrollmentPageFixtures";
import { DAY, insertDeal, insertPayment, insertPerson } from "../../tests/enrollmentReadFixtures";

afterEach(() => vi.useRealTimers());

async function detailFor(h: Awaited<ReturnType<typeof bookingHarness>>, leadId: Id<"leads">) {
  const detail = await h.admin.query(api.leadCustomers.detail.getEntityDetail, { leadId });
  if (detail?.kind !== "detail") throw new Error("Expected the person's detail");
  return detail;
}

describe("person page enrollments", () => {
  it("lists each program with its current name, status, deal and non-disputed payments", async () => {
    const h = await bookingHarness();
    const seeded = await h.t.run(async (ctx) => {
      const seeded = await seedEnrolledCustomer(ctx, h.tenantId, { secondProgram: true });
      // A second payment for Program A, and a disputed one that doesn't count.
      await insertPayment(ctx, {
        tenantId: h.tenantId, opportunityId: seeded.dealA, recordedByUserId: seeded.closerId,
        programId: seeded.programA, amountMinor: 50_000, recordedAt: ENROLLED_AT + 2 * DAY,
      });
      await insertPayment(ctx, {
        tenantId: h.tenantId, opportunityId: seeded.dealA, recordedByUserId: seeded.closerId,
        programId: seeded.programA, amountMinor: 999_999, recordedAt: ENROLLED_AT + 3 * DAY,
        status: "disputed",
      });
      // Renamed since: the page shows the program's current name.
      await ctx.db.patch("tenantPrograms", seeded.programA, { name: "Program A+" });
      await ctx.db.patch("enrollments", seeded.second!.enrollmentId, {
        status: "paused",
        statusChangedAt: ENROLLED_AT + 4 * DAY,
        statusChangedByUserId: seeded.adminId,
      });
      return seeded;
    });

    const detail = await detailFor(h, seeded.leadId);

    expect(detail).not.toHaveProperty("customer");
    expect(detail.enrollments).toEqual([
      {
        enrollmentId: seeded.enrollmentA,
        programId: seeded.programA,
        programName: "Program A+",
        status: "active",
        enrolledAt: ENROLLED_AT,
        opportunityId: seeded.dealA,
        statusChangedAt: null,
        statusChangedBy: null,
        totalPaidMinor: 350_000,
        currency: "USD",
        paymentCount: 2,
      },
      {
        enrollmentId: seeded.second!.enrollmentId,
        programId: seeded.second!.programId,
        programName: "Program B",
        status: "paused",
        enrolledAt: ENROLLED_AT + DAY,
        opportunityId: seeded.second!.dealId,
        statusChangedAt: ENROLLED_AT + 4 * DAY,
        statusChangedBy: { userId: seeded.adminId, name: "admin@example.com" },
        totalPaidMinor: 120_000,
        currency: "USD",
        paymentCount: 1,
      },
    ]);
    expect(detail.customerSummary).toEqual({
      status: "active",
      totalPaidMinor: 470_000,
      currency: "USD",
      paymentCount: 3,
      customerSince: ENROLLED_AT,
      programNames: ["Program A+", "Program B"],
      winningOpportunityId: seeded.dealA,
    });
  });

  it("gives the person-level status and keeps a deleted changer's ID with no name", async () => {
    const h = await bookingHarness();
    const { seeded, goneUserId } = await h.t.run(async (ctx) => {
      const seeded = await seedEnrolledCustomer(ctx, h.tenantId, { secondProgram: true });
      const goneUserId = await ctx.db.insert("users", {
        tenantId: h.tenantId, workosUserId: "user_gone", email: "gone@example.com",
        role: "tenant_admin", isActive: true,
      });
      await ctx.db.delete("users", goneUserId);
      for (const enrollmentId of [seeded.enrollmentA, seeded.second!.enrollmentId]) {
        await ctx.db.patch("enrollments", enrollmentId, {
          status: enrollmentId === seeded.enrollmentA ? "churned" : "paused",
          statusChangedAt: ENROLLED_AT + 5 * DAY,
          statusChangedByUserId: goneUserId,
        });
      }
      return { seeded, goneUserId };
    });

    const detail = await detailFor(h, seeded.leadId);

    expect(detail.customerSummary?.status).toBe("paused");
    // The page shows "by Removed user" for these.
    expect(detail.enrollments.map((enrollment) => enrollment.statusChangedBy)).toEqual([
      { userId: goneUserId, name: null },
      { userId: goneUserId, name: null },
    ]);
    expect(detail.enrollments.map((enrollment) => enrollment.statusChangedAt)).toEqual([
      ENROLLED_AT + 5 * DAY,
      ENROLLED_AT + 5 * DAY,
    ]);
  });

  it("has a change time but no changer for a status the backfill carried from the customer row", async () => {
    const h = await bookingHarness();
    const seeded = await h.t.run(async (ctx) => {
      const seeded = await seedEnrolledCustomer(ctx, h.tenantId);
      // backfillEnrollments sets statusChangedAt from pausedAt and records no user.
      await ctx.db.patch("enrollments", seeded.enrollmentA, {
        status: "paused",
        statusChangedAt: ENROLLED_AT + 6 * DAY,
      });
      return seeded;
    });

    const detail = await detailFor(h, seeded.leadId);

    expect(detail.enrollments[0]).toMatchObject({
      status: "paused",
      statusChangedAt: ENROLLED_AT + 6 * DAY,
      statusChangedBy: null,
    });
  });

  it("lists payments on the person's deals only, with no customer-only branch", async () => {
    const h = await bookingHarness();
    const seeded = await h.t.run(async (ctx) => {
      const seeded = await seedEnrolledCustomer(ctx, h.tenantId);
      // A customer payment with no deal; production has none (§2.2).
      await ctx.db.insert("paymentRecords", {
        tenantId: h.tenantId, amountMinor: 10_000, currency: "USD",
        recordedByUserId: seeded.adminId, commissionable: false, programId: seeded.programA,
        programName: "Program A", paymentType: "monthly", status: "recorded",
        recordedAt: ENROLLED_AT + DAY, customerId: seeded.customerId,
        contextType: "customer", origin: "customer_direct",
      });
      return seeded;
    });

    const detail = await detailFor(h, seeded.leadId);

    expect(detail.payments.map((payment) => payment._id)).toEqual([seeded.paymentA]);
    expect(detail.payments[0]).toMatchObject({ opportunityId: seeded.dealA });
    expect(detail.payments[0]).not.toHaveProperty("customerId");
    expect(detail.customerSummary?.totalPaidMinor).toBe(300_000);
  });

  it("counts the payments on every deal the enrollments derive from, past the 50 deals it lists", async () => {
    const h = await bookingHarness();
    const seeded = await h.t.run(async (ctx) => {
      const seeded = await seedEnrolledCustomer(ctx, h.tenantId);
      // 55 later deals with no payment push the paid deal out of the newest 50.
      for (let index = 0; index < 55; index++) {
        await insertDeal(ctx, {
          tenantId: h.tenantId, leadId: seeded.leadId, status: "lost",
          createdAt: ENROLLED_AT + (index + 1) * DAY,
        });
      }
      return seeded;
    });

    const detail = await detailFor(h, seeded.leadId);

    expect(detail.opportunities).toHaveLength(50);
    expect(detail.opportunities.some(({ opportunity }) => opportunity._id === seeded.dealA)).toBe(false);
    expect(detail.caps.opportunities).toBe(true);
    expect(detail.enrollments[0]).toMatchObject({ totalPaidMinor: 300_000, paymentCount: 1 });
    expect(detail.customerSummary?.totalPaidMinor).toBe(300_000);
    expect(detail.payments.map((payment) => payment._id)).toEqual([seeded.paymentA]);
    expect(detail.caps.payments).toBe(false);
  });

  it("gives no total for payments in more than one currency", async () => {
    const h = await bookingHarness();
    const seeded = await h.t.run(async (ctx) => {
      const seeded = await seedEnrolledCustomer(ctx, h.tenantId);
      await insertPayment(ctx, {
        tenantId: h.tenantId, opportunityId: seeded.dealA, programId: seeded.programA,
        recordedByUserId: seeded.adminId, recordedAt: ENROLLED_AT + DAY, amountMinor: 50_000, currency: "EUR",
      });
      return seeded;
    });

    const detail = await detailFor(h, seeded.leadId);

    expect(detail.enrollments[0]).toMatchObject({ totalPaidMinor: null, currency: null, paymentCount: 2 });
    expect(detail.customerSummary).toMatchObject({ totalPaidMinor: null, currency: null, paymentCount: 2 });
  });

  it("has no enrollments or customer summary for a person who hasn't bought", async () => {
    const h = await bookingHarness();
    const leadId = await h.t.run((ctx) => insertPerson(ctx, h.tenantId, { fullName: "Lee Lead" }));

    const detail = await detailFor(h, leadId);

    expect(detail.enrollments).toEqual([]);
    expect(detail.customerSummary).toBeNull();
  });

  it("shows a closer the same programs and totals", async () => {
    const h = await bookingHarness();
    const seeded = await h.t.run((ctx) => seedEnrolledCustomer(ctx, h.tenantId));

    const detail = await h.closer.query(api.leadCustomers.detail.getEntityDetail, {
      leadId: seeded.leadId,
    });

    if (detail?.kind !== "detail") throw new Error("Expected the person's detail");
    expect(detail.enrollments.map((enrollment) => enrollment.programName)).toEqual(["Program A"]);
    expect(detail.customerSummary?.totalPaidMinor).toBe(300_000);
  });
});
