import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";
import {
  activityEvent,
  legacyActivityHarness,
} from "../../tests/activityCountFixtures";
import { seedEnrolledCustomer } from "../../tests/enrollmentPageFixtures";
import { insertMeeting } from "../../tests/enrollmentReadFixtures";
import { SYSTEM_ADMIN_ORG_ID } from "../lib/constants";
import { emitDomainEvent } from "../lib/domainEvents";
import {
  activityEventCounts,
  assertActivityEventCountEntries,
  deleteActivityEventCounts,
  insertActivityEventCounts,
} from "./activityEventCounts";
import { readScannedActivitySummary } from "./activityFeed";
import {
  businessDateToUtcStart,
  timestampToBusinessDateKey,
} from "./lib/hondurasBusinessTime";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const DAY = 86_400_000;
const END = businessDateToUtcStart(timestampToBusinessDateKey(NOW));
const RANGE = { startDate: END - DAY, endDate: END };
afterEach(() => vi.useRealTimers());

async function harness() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  return await bookingHarness();
}

async function enable(h: Awaited<ReturnType<typeof harness>>) {
  for (let day = 30; day > 0; day--) {
    const result = await h.t.mutation(
      internal.reporting.activityEventCounts.markActivityEventCountsVerified,
      {
        tenantId: h.tenantId,
        startDate: END - day * DAY,
        endDate: END - (day - 1) * DAY,
      },
    );
    expect(result).toMatchObject({
      passed: true,
      enabled: day === 1,
      verifiedDays: 31 - day,
    });
  }
}

describe("activity event counts", () => {
  it("emitDomainEvent writes every dimension, including reminder prefix and skipAnalytics events", async () => {
    const h = await harness();
    await h.t.run(async (ctx) => {
      const id = await emitDomainEvent(ctx, {
        tenantId: h.tenantId,
        entityType: "followUp",
        entityId: "missing",
        eventType: "followUp.completed",
        source: "system",
        metadata: { outcome: "payment_received" },
        occurredAt: RANGE.startDate,
        skipAnalytics: true,
      });
      const event = await ctx.db.get("domainEvents", id);
      expect(event).not.toBeNull();
      await insertActivityEventCounts(ctx, event!);
      await assertActivityEventCountEntries(ctx, event!);
      expect(
        await activityEventCounts.count(ctx, { namespace: h.tenantId }),
      ).toBe(6);
      expect(
        await activityEventCounts.count(ctx, {
          namespace: h.tenantId,
          bounds: { prefix: ["reminderOutcome", "reminder_payment_received"] },
        }),
      ).toBe(1);
      expect(
        await activityEventCounts.count(ctx, {
          namespace: h.tenantId,
          bounds: { prefix: ["actor", ""] },
        }),
      ).toBe(1);
      await deleteActivityEventCounts(ctx, event!);
      await expect(
        assertActivityEventCountEntries(ctx, event!),
      ).rejects.toThrow(String(event!._id));
      await deleteActivityEventCounts(ctx, event!);
      expect(
        await activityEventCounts.count(ctx, { namespace: h.tenantId }),
      ).toBe(0);
    });
  });

  it("backfills idempotently and keeps the summary on its scan until all 30 day checks pass", async () => {
    const h = await harness();
    await h.t.run(async (ctx) => {
      await activityEvent(
        ctx,
        h.tenantId,
        { occurredAt: RANGE.startDate },
        false,
      );
    });
    const args = { ...RANGE, tenantId: h.tenantId };
    expect(
      await h.admin.query(api.reporting.activityFeed.getActivitySummary, RANGE),
    ).toMatchObject({ totalEvents: 1 });
    expect(
      await h.t.query(
        internal.reporting.activityEventCounts.verifyActivityEventCounts,
        args,
      ),
    ).toMatchObject({ passed: false });
    expect(
      await h.t.mutation(
        internal.reporting.activityEventCounts.markActivityEventCountsVerified,
        args,
      ),
    ).toMatchObject({ passed: false, enabled: false });
    for (let run = 0; run < 2; run++)
      expect(
        await h.t.mutation(
          internal.reporting.activityEventCounts.backfillActivityEventCounts,
          {},
        ),
      ).toMatchObject({ processed: 1, isDone: true });
    expect(
      await h.t.query(
        internal.reporting.activityEventCounts.verifyActivityEventCounts,
        args,
      ),
    ).toMatchObject({ passed: true, differences: [] });
    await enable(h);
    expect(
      await h.admin.query(api.reporting.activityFeed.getActivitySummary, RANGE),
    ).toMatchObject({ totalEvents: 1, isTruncated: false });
    await expect(
      h.t.mutation(
        internal.reporting.activityEventCounts.markActivityEventCountsVerified,
        { ...args, startDate: RANGE.startDate - 1 },
      ),
    ).rejects.toThrow("last 30 completed");
  });

  it("counts the old event beyond a small scan cap, excludes no-actor events from Removed user, and respects [start,end)", async () => {
    const h = await harness();
    const ids = await h.t.run(async (ctx) => {
      const users = await ctx.db
        .query("users")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", h.tenantId))
        .take(10);
      const removed = users.find((user) => user.role === "closer")!;
      const known = users.find((user) => user.role === "tenant_admin")!;
      await activityEvent(ctx, h.tenantId, {
        occurredAt: RANGE.startDate,
        entityType: "followUp",
        eventType: "followUp.completed",
        actorUserId: removed._id,
        metadata: '{"outcome":"lost"}',
      });
      for (let index = 0; index < 5; index++)
        await activityEvent(ctx, h.tenantId, {
          occurredAt: RANGE.startDate + index + 1,
          actorUserId: index < 2 ? known._id : undefined,
        });
      await activityEvent(ctx, h.tenantId, { occurredAt: RANGE.endDate });
      await ctx.db.delete("users", removed._id);
      const truncated = await readScannedActivitySummary(
        ctx,
        h.tenantId,
        RANGE.startDate,
        RANGE.endDate,
        3,
      );
      expect(truncated).toMatchObject({
        totalEvents: 3,
        isTruncated: true,
        byOutcome: {},
      });
      return { known: known._id };
    });
    await enable(h);
    const summary = await h.admin.query(
      api.reporting.activityFeed.getActivitySummary,
      RANGE,
    );
    expect(summary).toMatchObject({
      totalEvents: 6,
      isTruncated: false,
      byOutcome: { reminder_lost: 1 },
      byActor: { [ids.known]: 2, removed: 1 },
    });
    expect(summary.actorBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorName: "Removed user", count: 1 }),
      ]),
    );
    expect(
      summary.actorBreakdown.reduce((sum, actor) => sum + actor.count, 0),
    ).toBe(3);
  });

  it("removes aggregate entries through testing cleanup and tenant teardown, including rows never backfilled", async () => {
    for (const cleanup of ["reset", "tenant"] as const) {
      const h = await harness();
      await h.t.run(async (ctx) => {
        await activityEvent(ctx, h.tenantId, { occurredAt: RANGE.startDate });
        await activityEvent(
          ctx,
          h.tenantId,
          { occurredAt: RANGE.startDate + 1 },
          false,
        );
      });
      if (cleanup === "reset")
        await h.t.mutation(
          internal.testing.operationalData.deleteOperationalDataBatch,
          { tableName: "domainEvents" },
        );
      else
        await h.t.mutation(
          internal.admin.tenantsMutations.deleteTenantRuntimeDataBatch,
          { tenantId: h.tenantId },
        );
      expect(
        await h.t.run(async (ctx) =>
          activityEventCounts.count(ctx, { namespace: h.tenantId }),
        ),
      ).toBe(0);
    }
  });

  it("preserves free-string historical event types and the old reminder prefix semantics", async () => {
    const h = await harness();
    await h.t.run(async (ctx) => {
      await activityEvent(ctx, h.tenantId, {
        occurredAt: RANGE.startDate,
        eventType: "historical.custom",
      });
      await activityEvent(ctx, h.tenantId, {
        occurredAt: RANGE.startDate,
        eventType: "followUp.completed",
        metadata: '{"outcome":"reminder_lost"}',
      });
      await activityEvent(ctx, h.tenantId, {
        occurredAt: RANGE.startDate,
        eventType: "followUp.completed",
        metadata: "null",
      });
      await activityEvent(ctx, h.tenantId, {
        occurredAt: RANGE.startDate,
        eventType: "followUp.completed",
        metadata: "malformed",
      });
    });
    await enable(h);
    expect(
      await h.admin.query(api.reporting.activityFeed.getActivitySummary, RANGE),
    ).toMatchObject({
      totalEvents: 4,
      isTruncated: false,
      byEventType: { "historical.custom": 1, "followUp.completed": 3 },
      byOutcome: { reminder_reminder_lost: 1 },
    });
  });
  it("deletes opportunity and meeting entries through the blocker purge", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = await legacyActivityHarness();
    await h.t.run(async (ctx) => {
      const seeded = await seedEnrolledCustomer(ctx, h.tenantId);
      const meetingId = await insertMeeting(ctx, {
        tenantId: h.tenantId,
        opportunityId: seeded.dealA,
        closerId: seeded.closerId,
        scheduledAt: RANGE.startDate,
      });
      await ctx.db.patch("meetings", meetingId, {
        assignedCloserId: undefined,
      });
      await activityEvent(ctx, h.tenantId, {
        entityType: "opportunity",
        entityId: seeded.dealA,
        eventType: "opportunity.created",
        occurredAt: RANGE.startDate,
      });
      await activityEvent(ctx, h.tenantId, {
        entityType: "meeting",
        entityId: meetingId,
        eventType: "meeting.created",
        occurredAt: RANGE.startDate,
      });
    });
    const system = h.t.withIdentity({
      subject: "system",
      org_id: SYSTEM_ADMIN_ORG_ID,
    });
    await system.mutation(api.admin.migrations.purgePhase6BlockerRecords, {});
    expect(
      await h.t.run(async (ctx) =>
        activityEventCounts.count(ctx, { namespace: h.tenantId }),
      ),
    ).toBe(0);
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("keeps the scan path when historical value discovery overflows its bound", async () => {
    const h = await harness();
    await h.t.run(async (ctx) => {
      await ctx.db.patch("tenants", h.tenantId, {
        activityEventCountsVerifiedAt: NOW,
        activityEventCountsExtraValues: {
          overflow: false,
          values: Array.from({ length: 128 }, (_, index) => ({
            dimension: "eventType",
            value: `legacy.${index}`,
          })),
        },
      });
      await activityEvent(ctx, h.tenantId, {
        eventType: "legacy.overflow",
        occurredAt: RANGE.startDate,
      });
    });
    expect(
      await h.admin.query(api.reporting.activityFeed.getActivitySummary, RANGE),
    ).toMatchObject({ totalEvents: 1, byEventType: { "legacy.overflow": 1 } });
    const tenant = await h.t.run(async (ctx) =>
      ctx.db.get("tenants", h.tenantId),
    );
    expect(tenant?.activityEventCountsVerifiedAt).toBeUndefined();
    expect(tenant?.activityEventCountsExtraValues?.overflow).toBe(true);
    expect(
      await h.t.mutation(
        internal.reporting.activityEventCounts.markActivityEventCountsVerified,
        { ...RANGE, tenantId: h.tenantId },
      ),
    ).toMatchObject({ enabled: false, passed: false });
  });
});
