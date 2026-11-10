import { v } from "convex/values";
import { addBusinessDays, businessDateForInstant, businessDayStart } from "../../lib/businessDay";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { log } from "../lib/observability/log";
import { contributionStatus, requestMeetingProjection, successorMeeting } from "./meetingStats";

// After the deploy that adds the `moved` projection status, the canceled
// meetings another meeting already replaced still count as canceled until
// their projections run again (docs/reviews/reports-decisions.html, D9).
// Run the re-queue with `dryRun: true` to see how many slots move, then
// without it, wait for the projections to drain, then run the assert:
//
//   npx convex run operations/movedSlotProjections:requeueMovedSlotProjections '{"tenantId":"…","dryRun":true}'
//   npx convex run operations/movedSlotProjections:requeueMovedSlotProjections '{"tenantId":"…"}'
//   npx convex run operations/movedSlotProjections:assertMovedSlotProjections '{"tenantId":"…"}'
//
// Each runs one page and schedules the next; the last page logs the totals.
// The projection is derived, so the previous code undoes it the same way:
// re-queue the same slots.

const REQUEUE_PAGE_SIZE = 100;
/** Business days the assert compares per call. */
const ASSERT_WINDOW_DAYS = 31;
// Bounds for one window; a tenant past them needs a smaller window.
const ASSERT_MEETING_LIMIT = 4000;
const ASSERT_BUCKET_LIMIT = 8192;

const monthCountsValidator = v.record(v.string(), v.number());

function addToMonth(byMonth: Record<string, number>, dayKey: string) {
  const month = dayKey.slice(0, 7);
  byMonth[month] = (byMonth[month] ?? 0) + 1;
}

/**
 * Re-queues the projection of each of the tenant's canceled meetings that
 * another meeting replaced, one page of canceled meetings at a time. With
 * `dryRun`, it writes nothing and only counts those slots by the month of
 * their business day.
 */
export const requeueMovedSlotProjections = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    /** Totals from the earlier pages of this run. */
    totals: v.optional(v.object({ scanned: v.number(), moved: v.number(), skippedNoDeal: v.optional(v.number()), byMonth: monthCountsValidator })),
  },
  returns: v.object({
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
    scanned: v.number(),
    moved: v.number(),
    skippedNoDeal: v.number(),
    byMonth: monthCountsValidator,
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? false;
    const setting = await getTenantBusinessDay(ctx, args.tenantId);
    const page = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
        q.eq("tenantId", args.tenantId).eq("status", "canceled"),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: REQUEUE_PAGE_SIZE });
    const totals = {
      scanned: args.totals?.scanned ?? 0,
      moved: args.totals?.moved ?? 0,
      skippedNoDeal: args.totals?.skippedNoDeal ?? 0,
      byMonth: { ...args.totals?.byMonth },
    };
    for (const meeting of page.page) {
      totals.scanned += 1;
      if (!(await successorMeeting(ctx, meeting))) continue;
      const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
      // Match the assert's source set; these relationships cannot project.
      if (!opportunity || opportunity.tenantId !== args.tenantId) {
        totals.skippedNoDeal += 1;
        continue;
      }
      totals.moved += 1;
      addToMonth(totals.byMonth, businessDateForInstant(meeting.scheduledAt, setting));
      if (!dryRun) await requestMeetingProjection(ctx, meeting.tenantId, meeting._id);
    }
    const continueCursor = page.isDone ? null : page.continueCursor;
    log.info(
      page.isDone ? "operations.moved_slots.requeue.completed" : "operations.moved_slots.requeue.batch",
      { tenantId: args.tenantId, dryRun, scanned: totals.scanned, moved: totals.moved, skippedNoDeal: totals.skippedNoDeal, byMonth: JSON.stringify(totals.byMonth) },
    );
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.operations.movedSlotProjections.requeueMovedSlotProjections, {
        tenantId: args.tenantId,
        dryRun,
        cursor: continueCursor,
        totals,
      });
    }
    return { isDone: page.isDone, continueCursor, ...totals };
  },
});

async function firstAndLastDayKeys(ctx: MutationCtx, tenantId: Id<"tenants">) {
  const setting = await getTenantBusinessDay(ctx, tenantId);
  const meetings = (order: "asc" | "desc") =>
    ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "canceled"),
      )
      .order(order)
      .first();
  const buckets = (order: "asc" | "desc") =>
    ctx.db
      .query("operationsMeetingStatsV2")
      .withIndex("by_tenantId_and_dayKey", (q) => q.eq("tenantId", tenantId))
      .order(order)
      .first();
  const [firstMeeting, lastMeeting, firstBucket, lastBucket] = await Promise.all([
    meetings("asc"),
    meetings("desc"),
    buckets("asc"),
    buckets("desc"),
  ]);
  const days = [
    firstMeeting && businessDateForInstant(firstMeeting.scheduledAt, setting),
    lastMeeting && businessDateForInstant(lastMeeting.scheduledAt, setting),
    firstBucket?.dayKey,
    lastBucket?.dayKey,
  ].filter((day): day is string => typeof day === "string");
  if (days.length === 0) return null;
  days.sort();
  return { first: days[0], last: days[days.length - 1] };
}

type DayCounts = { moved: number; canceled: number };

/**
 * Compares, for each business day, the tenant's moved and canceled bucket
 * totals with the counts its canceled meetings give, and throws on the first
 * day that differs. It checks `ASSERT_WINDOW_DAYS` days per call, from the
 * tenant's first such day (or `fromDayKey`) through its last, and schedules
 * the next window; the last one logs the totals. Projections still queued or
 * failed would make the counts differ, so it throws until they drain.
 */
export const assertMovedSlotProjections = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    fromDayKey: v.optional(v.string()),
    /** Check one window and stop, instead of scheduling the next. */
    once: v.optional(v.boolean()),
    totals: v.optional(v.object({ days: v.number(), moved: v.number(), canceled: v.number() })),
  },
  returns: v.object({
    isDone: v.boolean(),
    nextFromDayKey: v.union(v.string(), v.null()),
    days: v.number(),
    moved: v.number(),
    canceled: v.number(),
  }),
  handler: async (ctx, args) => {
    const { tenantId } = args;
    for (const status of ["queued", "failed"] as const) {
      const pending = await ctx.db
        .query("meetingProjections")
        .withIndex("by_tenantId_and_status_and_requestedAt", (q) =>
          q.eq("tenantId", tenantId).eq("status", status),
        )
        .first();
      if (pending) throw new Error(`Meeting projections are ${status}; drain them before asserting`);
    }
    const totals = { days: 0, moved: 0, canceled: 0, ...args.totals };
    const span = await firstAndLastDayKeys(ctx, tenantId);
    if (!span) return { isDone: true, nextFromDayKey: null, ...totals };
    const from = args.fromDayKey ?? span.first;
    const toExclusive = addBusinessDays(from, ASSERT_WINDOW_DAYS);
    const setting = await getTenantBusinessDay(ctx, tenantId);

    const expected = new Map<string, DayCounts>();
    const day = (byDay: Map<string, DayCounts>, key: string) => {
      const counts = byDay.get(key) ?? { moved: 0, canceled: 0 };
      byDay.set(key, counts);
      return counts;
    };
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("status", "canceled")
          .gte("scheduledAt", businessDayStart(from, setting))
          .lt("scheduledAt", businessDayStart(toExclusive, setting)),
      )
      .take(ASSERT_MEETING_LIMIT + 1);
    if (meetings.length > ASSERT_MEETING_LIMIT)
      throw new Error(`More than ${ASSERT_MEETING_LIMIT} canceled meetings from ${from}; assert a smaller window`);
    for (const meeting of meetings) {
      const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
      // The projection counts no meeting whose deal is gone.
      if (!opportunity || opportunity.tenantId !== tenantId) continue;
      const status = await contributionStatus(ctx, meeting);
      const counts = day(expected, businessDateForInstant(meeting.scheduledAt, setting));
      if (status === "moved") counts.moved += 1;
      else counts.canceled += 1;
    }

    const projected = new Map<string, DayCounts>();
    const buckets = await ctx.db
      .query("operationsMeetingStatsV2")
      .withIndex("by_tenantId_and_dayKey", (q) =>
        q.eq("tenantId", tenantId).gte("dayKey", from).lt("dayKey", toExclusive),
      )
      .take(ASSERT_BUCKET_LIMIT + 1);
    if (buckets.length > ASSERT_BUCKET_LIMIT)
      throw new Error(`More than ${ASSERT_BUCKET_LIMIT} buckets from ${from}; assert a smaller window`);
    for (const bucket of buckets) {
      if (bucket.meetingStatus === "moved") day(projected, bucket.dayKey).moved += bucket.count;
      if (bucket.meetingStatus === "canceled") day(projected, bucket.dayKey).canceled += bucket.count;
    }

    for (const key of [...new Set([...expected.keys(), ...projected.keys()])].sort()) {
      const want = expected.get(key) ?? { moved: 0, canceled: 0 };
      const got = projected.get(key) ?? { moved: 0, canceled: 0 };
      if (want.moved !== got.moved || want.canceled !== got.canceled) {
        throw new Error(
          `Moved slot projection mismatch on ${key}: meetings give ${want.moved} moved and ${want.canceled} canceled, buckets hold ${got.moved} moved and ${got.canceled} canceled`,
        );
      }
      totals.days += 1;
      totals.moved += want.moved;
      totals.canceled += want.canceled;
    }

    const isDone = toExclusive > span.last;
    const nextFromDayKey = isDone ? null : toExclusive;
    log.info(isDone ? "operations.moved_slots.assert.completed" : "operations.moved_slots.assert.batch", {
      tenantId,
      fromDayKey: from,
      ...totals,
    });
    if (!isDone && !args.once) {
      await ctx.scheduler.runAfter(0, internal.operations.movedSlotProjections.assertMovedSlotProjections, {
        tenantId,
        fromDayKey: toExclusive,
        totals,
      });
    }
    return { isDone, nextFromDayKey, ...totals };
  },
});
