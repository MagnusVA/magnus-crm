/**
 * The admin dashboard's new customers in a period: the people whose first
 * enrollment falls in it (docs/plans/phase-4-customers.md §6.3).
 */
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";
import {
  fixtureUsers,
  insertDeal,
  insertEnrollment,
  insertPayment,
  insertProgram,
  seedCustomer,
} from "../../tests/enrollmentReadFixtures";
import {
  countNewCustomersFromCustomers,
  countNewCustomersFromEnrollments,
} from "./adminStats";

const JUNE = { start: Date.parse("2026-06-01T00:00:00Z"), end: Date.parse("2026-07-01T00:00:00Z") };

async function seed() {
  const harness = await bookingHarness();
  const { t, tenantId } = harness;
  await t.run(async (ctx) => {
    const { admin, closer } = await fixtureUsers(ctx, tenantId);
    const first = await insertProgram(ctx, tenantId, admin._id, "First");
    const second = await insertProgram(ctx, tenantId, admin._id, "Second");
    // Became a customer in May, bought a second program in June.
    const repeat = await seedCustomer(ctx, tenantId, {
      closerId: closer._id,
      programId: first,
      paidAt: Date.parse("2026-05-20T12:00:00Z"),
    });
    const dealId = await insertDeal(ctx, { tenantId, leadId: repeat.leadId, assignedCloserId: closer._id });
    const paidAt = Date.parse("2026-06-03T12:00:00Z");
    await insertPayment(ctx, { tenantId, opportunityId: dealId, programId: second, recordedByUserId: closer._id, recordedAt: paidAt });
    await insertEnrollment(ctx, { tenantId, leadId: repeat.leadId, programId: second, opportunityId: dealId, enrolledAt: paidAt });
    // Two new customers in June.
    await seedCustomer(ctx, tenantId, { closerId: closer._id, programId: first, paidAt: Date.parse("2026-06-10T12:00:00Z") });
    await seedCustomer(ctx, tenantId, { closerId: closer._id, programId: second, paidAt: Date.parse("2026-06-11T12:00:00Z") });
  });
  return harness;
}

describe("admin dashboard new customers", () => {
  it("counts first enrollments, not a customer's second program", async () => {
    const { t, tenantId } = await seed();
    const fromEnrollments = await t.run((ctx) =>
      countNewCustomersFromEnrollments(ctx, tenantId, JUNE.start, JUNE.end),
    );
    const fromCustomers = await t.run((ctx) =>
      countNewCustomersFromCustomers(ctx, tenantId, JUNE.start, JUNE.end),
    );
    expect(fromEnrollments).toEqual({ count: 2, isTruncated: false });
    expect(fromCustomers).toEqual({ count: 2, isTruncated: false });
  });

  it("reports the period's new customers", async () => {
    const { admin } = await seed();
    const stats = await admin.query(api.dashboard.adminStats.getTimePeriodStats, {
      periodStart: JUNE.start,
      periodEnd: JUNE.end,
    });
    expect(stats.newCustomers).toBe(2);
  });
});
