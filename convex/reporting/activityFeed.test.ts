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
const PAGINATION = { numItems: 50, cursor: null };
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
        paginationOpts: PAGINATION,
        entityType: "enrollment",
      },
    );
    const customerFeed = await h.admin.query(
      api.reporting.activityFeed.getActivityFeed,
      {
        ...RANGE,
        paginationOpts: PAGINATION,
        entityType: "customer",
      },
    );
    const summary = await h.admin.query(
      api.reporting.activityFeed.getActivitySummary,
      RANGE,
    );

    expect(enrollmentFeed.page).toHaveLength(1);
    expect(enrollmentFeed.page[0]).toMatchObject({
      eventType: "enrollment.status_changed",
      fromStatus: "active",
      toStatus: "churned",
      reason: "Stopped paying",
    });
    expect(customerFeed.page.map((event) => event.eventType)).toEqual([
      "customer.converted",
    ]);
    expect(summary.byEntity).toMatchObject({ enrollment: 1, customer: 1 });
  });
});

it("reaches an old event after 50 events sharing a timestamp", async () => {
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
          occurredAt: index === 50 ? RANGE.startDate : NOW,
          source: "admin",
        }),
      );
    }
    return ids;
  });
  const first = await h.admin.query(
    api.reporting.activityFeed.getActivityFeed,
    { ...RANGE, paginationOpts: PAGINATION },
  );
  expect(first.page).toHaveLength(50);
  expect(first.isDone).toBe(false);
  const second = await h.admin.query(
    api.reporting.activityFeed.getActivityFeed,
    {
      ...RANGE,
      paginationOpts: { ...PAGINATION, cursor: first.continueCursor },
    },
  );
  expect(second.page.map((event) => event._id)).toEqual([ids[50]]);
  expect(second.isDone).toBe(true);
  expect(
    new Set([...first.page, ...second.page].map((event) => event._id)),
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
    { ...args, paginationOpts: PAGINATION },
  );
  expect(first.page).toEqual([]);
  expect(first.isDone).toBe(false);
  const second = await h.admin.query(
    api.reporting.activityFeed.getActivityFeed,
    {
      ...args,
      paginationOpts: { ...PAGINATION, cursor: first.continueCursor },
    },
  );
  expect(second.page.map((event) => event._id)).toEqual([oldId]);
  expect(second.isDone).toBe(true);
});

it("keeps a loaded page's end cursor when new events arrive or old events are deleted", async () => {
  const h = await bookingHarness();
  const ids = await h.t.run(async (ctx) => {
    const ids = [];
    for (let index = 0; index < 3; index++) {
      ids.push(await ctx.db.insert("domainEvents", {
        tenantId: h.tenantId,
        entityType: "user",
        entityId: "historical",
        eventType: "user.created",
        occurredAt: NOW + index,
        source: "admin",
      }));
    }
    return ids;
  });
  const first = await h.admin.query(api.reporting.activityFeed.getActivityFeed, {
    ...RANGE,
    paginationOpts: { numItems: 2, cursor: null },
  });
  const newId = await h.t.run(async (ctx) => {
    await ctx.db.delete("domainEvents", ids[2]);
    return await ctx.db.insert("domainEvents", {
      tenantId: h.tenantId,
      entityType: "user",
      entityId: "new",
      eventType: "user.created",
      occurredAt: NOW + 3,
      source: "admin",
    });
  });
  const refreshed = await h.admin.query(api.reporting.activityFeed.getActivityFeed, {
    ...RANGE,
    paginationOpts: {
      numItems: 1,
      cursor: null,
      endCursor: first.continueCursor,
    },
  });
  expect(refreshed.page.map((event) => event._id)).toEqual([newId, ids[1]]);
  expect(refreshed.continueCursor).toBe(first.continueCursor);
  const next = await h.admin.query(api.reporting.activityFeed.getActivityFeed, {
    ...RANGE,
    paginationOpts: { numItems: 2, cursor: refreshed.continueCursor },
  });
  expect(next.page.map((event) => event._id)).toEqual([ids[0]]);
  expect(next.isDone).toBe(true);
});
