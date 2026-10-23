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
        // An old event keeps the ID of a customer row that is gone.
        tenantId: h.tenantId,
        entityType: "customer",
        entityId: "k170000000000000000000000000000",
        eventType: "customer.converted",
        occurredAt: NOW - 1_000,
        source: "closer",
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

    const enrollmentFeed = await h.admin.query(
      api.reporting.activityFeed.getActivityFeed,
      {
        ...RANGE,
        entityType: "enrollment",
      },
    );
    const customerFeed = await h.admin.query(
      api.reporting.activityFeed.getActivityFeed,
      {
        ...RANGE,
        entityType: "customer",
      },
    );
    const summary = await h.admin.query(
      api.reporting.activityFeed.getActivitySummary,
      RANGE,
    );

    expect(enrollmentFeed.events).toHaveLength(1);
    expect(enrollmentFeed.events[0]).toMatchObject({
      eventType: "enrollment.status_changed",
      fromStatus: "active",
      toStatus: "churned",
      reason: "Stopped paying",
    });
    expect(customerFeed.events.map((event) => event.eventType)).toEqual([
      "customer.converted",
    ]);
    expect(summary.byEntity).toMatchObject({ enrollment: 1, customer: 1 });
  });
});

it("continues past 50 events with a cursor, including events sharing a timestamp", async () => {
  const h = await bookingHarness();
  const ids = await h.t.run(async (ctx) => {
    const ids = [];
    for (let index = 0; index < 51; index++) {
      ids.push(
        await ctx.db.insert("domainEvents", {
          tenantId: h.tenantId,
          entityType: "user",
          entityId: "historical",
          eventType: "user.created",
          occurredAt: NOW,
          source: "admin",
        }),
      );
    }
    return ids;
  });
  const first = await h.admin.query(
    api.reporting.activityFeed.getActivityFeed,
    RANGE,
  );
  expect(first.events).toHaveLength(50);
  expect(first.isDone).toBe(false);
  const second = await h.admin.query(
    api.reporting.activityFeed.getActivityFeed,
    { ...RANGE, cursor: first.cursor },
  );
  expect(second.events).toHaveLength(1);
  expect(second.isDone).toBe(true);
  expect(
    new Set([...first.events, ...second.events].map((event) => event._id)),
  ).toEqual(new Set(ids));
});

it("returns a continuation after a filter consumes the 500-row budget without matches", async () => {
  const h = await bookingHarness();
  const oldId = await h.t.run(async (ctx) => {
    const oldId = await ctx.db.insert("domainEvents", {
      tenantId: h.tenantId,
      entityType: "enrollment",
      entityId: "historical",
      eventType: "enrollment.created",
      occurredAt: RANGE.startDate,
      source: "admin",
    });
    for (let index = 0; index < 500; index++)
      await ctx.db.insert("domainEvents", {
        tenantId: h.tenantId,
        entityType: "user",
        entityId: "historical",
        eventType: "user.created",
        occurredAt: NOW,
        source: "admin",
      });
    return oldId;
  });
  const args = { ...RANGE, entityType: "enrollment" as const };
  const first = await h.admin.query(
    api.reporting.activityFeed.getActivityFeed,
    args,
  );
  expect(first.events).toEqual([]);
  expect(first.isDone).toBe(false);
  const second = await h.admin.query(
    api.reporting.activityFeed.getActivityFeed,
    { ...args, cursor: first.cursor },
  );
  expect(second.events.map((event) => event._id)).toEqual([oldId]);
  expect(second.isDone).toBe(true);
});
