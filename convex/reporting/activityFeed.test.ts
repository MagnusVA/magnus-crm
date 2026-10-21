/**
 * The activity feed's entity filter has Enrollment beside Customer, which
 * keeps the older customer events (docs/plans/phase-4-customers.md §4.10).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";
import { seedEnrolledCustomer } from "../../tests/enrollmentPageFixtures";

afterEach(() => vi.useRealTimers());

const NOW = Date.parse("2026-10-10T12:00:00Z");
const RANGE = { startDate: NOW - 60_000, endDate: NOW + 60_000 };

describe("activity feed enrollment events", () => {
  it("filters to enrollment events and counts them by entity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const h = await bookingHarness();
    const seeded = await h.t.run(async (ctx) => {
      const seeded = await seedEnrolledCustomer(ctx, h.tenantId);
      await ctx.db.insert("domainEvents", {
        tenantId: h.tenantId, entityType: "customer", entityId: seeded.customerId,
        eventType: "customer.converted", occurredAt: NOW - 1_000, source: "closer",
        leadId: seeded.leadId,
      });
      return seeded;
    });
    await h.admin.mutation(api.enrollments.mutations.updateEnrollmentStatus, {
      enrollmentId: seeded.enrollmentA,
      status: "churned",
      expectedStatus: "active",
      reason: "Stopped paying",
    });

    const enrollmentFeed = await h.admin.query(api.reporting.activityFeed.getActivityFeed, {
      ...RANGE,
      entityType: "enrollment",
    });
    const customerFeed = await h.admin.query(api.reporting.activityFeed.getActivityFeed, {
      ...RANGE,
      entityType: "customer",
    });
    const summary = await h.admin.query(api.reporting.activityFeed.getActivitySummary, RANGE);

    expect(enrollmentFeed).toHaveLength(1);
    expect(enrollmentFeed[0]).toMatchObject({
      eventType: "enrollment.status_changed",
      fromStatus: "active",
      toStatus: "churned",
      reason: "Stopped paying",
    });
    expect(customerFeed.map((event) => event.eventType)).toEqual(["customer.converted"]);
    expect(summary.byEntity).toMatchObject({ enrollment: 1, customer: 1 });
  });
});
