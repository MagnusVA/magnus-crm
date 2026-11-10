import type { ReaderArgs } from "../analytics/assistantTypes";
import { paginationOptsValidator, paginationResultValidator, type PaginationOptions } from "convex/server";
import { mergedStream, stream } from "convex-helpers/server/stream";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { readLiveQueryRows } from "../lib/liveQueryBounds";
import {
  OPEN_PIPELINE_STAGES,
  readPipelineDistributionByStage,
  type OpenPipelineStage,
} from "../reporting/pipelineHealth";
import { meetingsByStatus } from "../reporting/aggregates";
import { getUserDisplayName } from "../reporting/lib/helpers";
import { requireTenantUser } from "../requireTenantUser";
import schema from "../schema";
import { REPORT_ADMIN_ROLES } from "./lib/access";
import { loadCallFacts } from "./lib/callFacts";
import { pipelineNextStep } from "./lib/pipelineNextStep";

import { nullableNumber, openStageValidator } from "./lib/validators";

const DAY = 86_400_000;
const PIPELINE_CAP = 500;
export type PipelineDeal = {
  opportunityId: Id<"opportunities">;
  leadName: string;
  stage: OpenPipelineStage;
  ageDays: number;
  closerName: string | null;
  nextStep: { kind: "call" | "task"; at: number | null } | null;
};
export type PipelineNow = {
  stages: Array<{
    stage: OpenPipelineStage;
    count: number;
    medianAgeDays: number | null;
    oldestAgeDays: number | null;
    partial: boolean;
  }>;
  noNextStep: { count: number; partial: boolean };
  overdueTasks: { count: number; partial: boolean };
  owed: {
    total: number | null;
    calls: Array<{
      meetingId: Id<"meetings">;
      opportunityId: Id<"opportunities">;
      scheduledAt: number;
      closerId: Id<"users">;
      closerName: string;
      leadName: string;
      ageDays: number;
    }>;
    partial: boolean;
  };
  bookingReviews: {
    count: number;
    oldest: {
      reviewId: Id<"bookingReviews">;
      createdAt: number;
      ageDays: number;
    } | null;
    partial: boolean;
  };
  aging: { deals: PipelineDeal[]; partial: boolean };
};
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export const pipelineNowValidator = v.object({
  stages: v.array(
    v.object({
      stage: openStageValidator,
      count: v.number(),
      medianAgeDays: nullableNumber,
      oldestAgeDays: nullableNumber,
      partial: v.boolean(),
    }),
  ),
  noNextStep: v.object({ count: v.number(), partial: v.boolean() }),
  overdueTasks: v.object({ count: v.number(), partial: v.boolean() }),
  owed: v.object({
    total: nullableNumber,
    calls: v.array(
      v.object({
        meetingId: v.id("meetings"),
        opportunityId: v.id("opportunities"),
        scheduledAt: v.number(),
        closerId: v.id("users"),
        closerName: v.string(),
        leadName: v.string(),
        ageDays: v.number(),
      }),
    ),
    partial: v.boolean(),
  }),
  bookingReviews: v.object({
    count: v.number(),
    oldest: v.union(
      v.object({
        reviewId: v.id("bookingReviews"),
        createdAt: v.number(),
        ageDays: v.number(),
      }),
      v.null(),
    ),
    partial: v.boolean(),
  }),
  aging: v.object({
    deals: v.array(
      v.object({
        opportunityId: v.id("opportunities"),
        leadName: v.string(),
        stage: openStageValidator,
        ageDays: v.number(),
        closerName: v.union(v.string(), v.null()),
        nextStep: v.union(
          v.object({
            kind: v.union(v.literal("call"), v.literal("task")),
            at: nullableNumber,
          }),
          v.null(),
        ),
      }),
    ),
    partial: v.boolean(),
  }),
});

export const listOpenDeals = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({
      opportunityId: v.id("opportunities"),
      stage: openStageValidator,
      createdAt: v.number(),
      leadName: v.string(),
      closerName: v.union(v.string(), v.null()),
      nextMeetingAt: nullableNumber,
      task: v.union(v.object({ at: nullableNumber }), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
    return readOpenDeals(ctx, tenantId, args);
  },
});

/** Trusted callers must authorize the tenant before reading this page. */
export async function readOpenDeals(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  args: { paginationOpts: PaginationOptions },
) {
  const database = stream(ctx.db, schema);
  const result = await mergedStream(
    OPEN_PIPELINE_STAGES.map((stage) =>
      database
        .query("opportunities")
        .withIndex("by_tenantId_and_stage_and_outcome_and_createdAt", (q) =>
          q.eq("tenantId", tenantId).eq("stage", stage).eq("outcome", "open"),
        )
        .order("asc"),
    ),
    ["createdAt", "_creationTime", "_id"],
  ).paginate({
    ...args.paginationOpts,
    numItems: Math.min(100, Math.max(1, args.paginationOpts.numItems)),
  });
  const closers = new Map<Id<"users">, string | null>();
  for (const id of new Set(
    result.page.flatMap((deal) =>
      deal.assignedCloserId ? [deal.assignedCloserId] : [],
    ),
  )) {
    const closer = await ctx.db.get("users", id);
    closers.set(
      id,
      closer?.tenantId === tenantId ? getUserDisplayName(closer) : null,
    );
  }
  const rows = await Promise.all(
    result.page.map(async (deal) => {
      const lead = await ctx.db.get("leads", deal.leadId);
      const task = await ctx.db
        .query("followUps")
        .withIndex("by_opportunityId_and_status_and_reason", (q) =>
          q.eq("opportunityId", deal._id).eq("status", "pending"),
        )
        .first();
      return {
        opportunityId: deal._id,
        stage: deal.stage as OpenPipelineStage,
        createdAt: deal.createdAt,
        leadName:
          lead?.tenantId === tenantId
            ? (lead.fullName ?? "Unknown person")
            : "Unknown person",
        closerName: deal.assignedCloserId
          ? (closers.get(deal.assignedCloserId) ?? null)
          : null,
        nextMeetingAt: deal.nextMeetingAt ?? null,
        task:
          task?.tenantId === tenantId
            ? { at: task.reminderScheduledAt ?? null }
            : null,
      };
    }),
  );
  return { ...result, page: rows };
}

export const listOwedCalls = query({
  args: { paginationOpts: paginationOptsValidator, endedBy: v.number() },
  returns: paginationResultValidator(
    v.object({
      meetingId: v.id("meetings"),
      opportunityId: v.id("opportunities"),
      scheduledAt: v.number(),
      endsAt: v.number(),
      closerId: v.id("users"),
      closerName: v.string(),
      leadName: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
    return readOwedCalls(ctx, tenantId, args);
  },
});

/** Trusted callers must authorize the tenant before reading this page. */
export async function readOwedCalls(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  args: { paginationOpts: PaginationOptions; endedBy: number },
) {
  if (!Number.isFinite(args.endedBy))
    throw new Error("endedBy must be finite.");
  const result = await stream(ctx.db, schema)
    .query("meetings")
    .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
      q
        .eq("tenantId", tenantId)
        .eq("status", "scheduled")
        .lte("scheduledAt", args.endedBy),
    )
    .order("asc")
    .filterWith(
      async (meeting) =>
        meeting.scheduledAt + meeting.durationMinutes * 60_000 <= args.endedBy,
    )
    .paginate({
      ...args.paginationOpts,
      numItems: Math.min(100, Math.max(1, args.paginationOpts.numItems)),
      maximumRowsRead: 500,
    });
  const { facts } = await loadCallFacts(
    ctx,
    tenantId,
    result.page,
    args.endedBy,
  );
  const byMeeting = new Map(facts.map((fact) => [fact.meeting._id, fact]));
  // Bounded enrichment can stop before the end of a page. A call it didn't
  // reach still owes a result, so it stays in the list under the closer it
  // is assigned to now, which is who has to record it.
  const assigned = new Map<Id<"users">, string>();
  for (const meeting of result.page) {
    const closerId = meeting.assignedCloserId;
    if (byMeeting.has(meeting._id) || assigned.has(closerId)) continue;
    const closer = await ctx.db.get("users", closerId);
    assigned.set(
      closerId,
      closer?.tenantId === tenantId
        ? getUserDisplayName(closer)
        : "Removed closer",
    );
  }
  return {
    ...result,
    page: result.page.map((meeting) => {
      const fact = byMeeting.get(meeting._id);
      return {
        meetingId: meeting._id,
        opportunityId: meeting.opportunityId,
        scheduledAt: meeting.scheduledAt,
        endsAt: meeting.scheduledAt + meeting.durationMinutes * 60_000,
        closerId: fact?.closerId ?? meeting.assignedCloserId,
        closerName:
          fact?.closerName ??
          assigned.get(meeting.assignedCloserId) ??
          "Removed closer",
        leadName: fact?.leadName ?? meeting.leadName ?? "Unknown person",
      };
    }),
  };
}

async function readOwedTotal(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  now: number,
  source: { rows: Doc<"meetings">[]; capped: boolean },
): Promise<number | null> {
  const isDue = (meeting: Doc<"meetings">) =>
    meeting.scheduledAt + meeting.durationMinutes * 60_000 <= now;
  if (!source.capped) return source.rows.filter(isDue).length;
  const last = source.rows.at(-1);
  if (!last) return null;
  const cutoff = now - 3 * 3_600_000;
  const recent = await readLiveQueryRows(
    ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("status", "scheduled")
          .gte("scheduledAt", cutoff)
          .lte("scheduledAt", now),
      ),
    PIPELINE_CAP,
  );
  const users = await readLiveQueryRows(
    ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)),
    500,
  );
  if (recent.capped || users.capped) return null;
  // Include inactive and former closers: ownership keys use users, not roles.
  const keys = users.rows.flatMap((user) =>
    (["new", "follow_up"] as const).map(
      (classification) => [user._id, classification, "scheduled"] as const,
    ),
  );
  // Reserve the transaction's remaining index ranges for the other panels.
  if (keys.length * 5 > 1500) return null;
  const timeKey = (
    key: (typeof keys)[number],
    at: number,
  ): [Id<"users">, "new" | "follow_up", "scheduled", number] => [...key, at];
  const before = (
    key: (typeof keys)[number],
    at: number,
    inclusive: boolean,
  ) => ({
    lower: { key: timeKey(key, Number.NEGATIVE_INFINITY), inclusive: true },
    upper: { key: timeKey(key, at), inclusive },
  });
  // Like Team, this uses the backfilled, strictly maintained meetings aggregate.
  // Check its sampled prefix and recent window before trusting the old count;
  // an incomplete backfill must not turn the headline into a plausible zero.
  const counts = await meetingsByStatus.countBatch(
    ctx,
    keys.flatMap((key) => [
      { namespace: tenantId, bounds: before(key, cutoff, false) },
      { namespace: tenantId, bounds: before(key, last.scheduledAt, false) },
      { namespace: tenantId, bounds: before(key, last.scheduledAt, true) },
      {
        namespace: tenantId,
        bounds: {
          lower: { key: timeKey(key, cutoff), inclusive: true },
          upper: { key: timeKey(key, now), inclusive: true },
        },
      },
      { namespace: tenantId, bounds: { prefix: [key[0], key[1]] } },
    ]),
  );
  const sums = [0, 0, 0, 0, 0];
  counts.forEach((count, index) => {
    sums[index % 5] += count;
  });
  const allMeetings = await meetingsByStatus.count(ctx, {
    namespace: tenantId,
  });
  const [oldCount, beforeSample, throughSample, recentCount, knownUserEntries] =
    sums;
  if (
    knownUserEntries !== allMeetings ||
    beforeSample !==
      source.rows.filter((m) => m.scheduledAt < last.scheduledAt).length ||
    throughSample < source.rows.length ||
    recentCount !== recent.rows.length
  )
    return null;
  return oldCount + recent.rows.filter(isDue).length;
}

export const getPipelineNow = query({
  returns: pipelineNowValidator,
  args: { asOf: v.optional(v.number()) },
  handler: async (ctx, args): Promise<PipelineNow> => {
    const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
    return readPipelineNow(ctx, tenantId, args);
  },
});

/** Shared load/build path. Trusted callers must authorize the tenant first. */
export async function readPipelineNow(ctx: QueryCtx, tenantId: Id<"tenants">, args: ReaderArgs<typeof getPipelineNow>): Promise<PipelineNow> {
  // The page can advance a minute clock without waiting for a data write.
  const now = args.asOf ?? Date.now();
  const tenant = await ctx.db.get("tenants", tenantId);
  // Pipeline Health already maintains the stage counts. Use them only once
  // verified; the fallback's counts and medians explicitly carry its bound.
  const distribution =
    tenant?.pipelineHealthAggregatesVerifiedAt === undefined
      ? null
      : await readPipelineDistributionByStage(ctx, tenantId);
  const open: Doc<"opportunities">[] = [];
  const stages: PipelineNow["stages"] = [];
  for (const stage of OPEN_PIPELINE_STAGES) {
    const scan = await readLiveQueryRows(
      ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_stage_and_outcome_and_createdAt", (q) =>
          q.eq("tenantId", tenantId).eq("stage", stage).eq("outcome", "open"),
        ),
      Math.floor(PIPELINE_CAP / OPEN_PIPELINE_STAGES.length),
    );
    open.push(...scan.rows);
    const ages = scan.rows.map((d) => Math.max(0, (now - d.createdAt) / DAY));
    const oldest = scan.rows[0];
    // Each stage has its own read budget so the oldest-deal list samples
    // every stage even when one stage exceeds its bound.
    const first =
      oldest ??
      (await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_stage_and_outcome_and_createdAt", (q) =>
          q.eq("tenantId", tenantId).eq("stage", stage).eq("outcome", "open"),
        )
        .first());
    stages.push({
      stage,
      count:
        distribution?.find((r) => r.position === stage)?.count ??
        scan.rows.length,
      medianAgeDays: scan.capped ? null : median(ages),
      oldestAgeDays: first
        ? Math.max(0, (now - first.createdAt) / DAY)
        : null,
      partial: scan.capped,
    });
  }
  const next = new Map<Id<"opportunities">, PipelineDeal["nextStep"]>();
  let noNextStep = 0;
  for (const deal of open) {
    const task = await ctx.db
      .query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) =>
        q.eq("opportunityId", deal._id).eq("status", "pending"),
      )
      .first();
    const step = pipelineNextStep(
      {
        nextMeetingAt: deal.nextMeetingAt,
        task:
          task?.tenantId === tenantId
            ? { at: task.reminderScheduledAt ?? null }
            : null,
      },
      now,
    );
    next.set(deal._id, step);
    if (!step) noNextStep++;
  }
  const pending = await readLiveQueryRows(
    ctx.db
      .query("followUps")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "pending"),
      ),
    PIPELINE_CAP,
  );
  const scheduled = await readLiveQueryRows(
    ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("status", "scheduled")
          .lte("scheduledAt", now),
      ),
    PIPELINE_CAP,
  );
  const due = scheduled.rows.filter(
    (m) => m.scheduledAt + m.durationMinutes * 60_000 <= now,
  );
  const owedTotal = await readOwedTotal(ctx, tenantId, now, scheduled);
  // The headline uses aggregate counts; enrich only the oldest visible calls.
  const owedFacts = await loadCallFacts(
    ctx,
    tenantId,
    due.slice(0, 100),
    now,
  );
  const reviews = await readLiveQueryRows(
    ctx.db
      .query("bookingReviews")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "open"),
      ),
    PIPELINE_CAP,
  );
  const oldestReview = reviews.rows[0];
  const oldest = open
    .sort((a, b) => a.createdAt - b.createdAt || a._id.localeCompare(b._id))
    .slice(0, 50);
  const aging: PipelineDeal[] = [];
  for (const deal of oldest) {
    const lead = await ctx.db.get("leads", deal.leadId);
    const closer = deal.assignedCloserId
      ? await ctx.db.get("users", deal.assignedCloserId)
      : null;
    aging.push({
      opportunityId: deal._id,
      stage: deal.stage as OpenPipelineStage,
      leadName:
        lead?.tenantId === tenantId
          ? (lead.fullName ?? "Unknown person")
          : "Unknown person",
      ageDays: Math.max(0, (now - deal.createdAt) / DAY),
      closerName:
        closer?.tenantId === tenantId ? getUserDisplayName(closer) : null,
      nextStep: next.get(deal._id) ?? null,
    });
  }
  const openPartial = stages.some((s) => s.partial);
  return {
    stages,
    noNextStep: { count: noNextStep, partial: openPartial },
    overdueTasks: {
      count: pending.rows.filter(
        (t) =>
          t.reminderScheduledAt !== undefined && t.reminderScheduledAt < now,
      ).length,
      partial: pending.capped,
    },
    owed: {
      total: owedTotal,
      calls: owedFacts.facts.map((f) => ({
        meetingId: f.meeting._id,
        opportunityId: f.meeting.opportunityId,
        scheduledAt: f.meeting.scheduledAt,
        closerId: f.closerId,
        closerName: f.closerName,
        leadName: f.leadName,
        ageDays: Math.max(
          0,
          (now - f.meeting.scheduledAt - f.meeting.durationMinutes * 60_000) /
            DAY,
        ),
      })),
      partial:
        owedTotal === null ||
        scheduled.capped ||
        owedFacts.partial ||
        due.length > 100,
    },
    bookingReviews: {
      count: reviews.rows.length,
      oldest: oldestReview
        ? {
            reviewId: oldestReview._id,
            createdAt: oldestReview.createdAt,
            ageDays: Math.max(0, (now - oldestReview.createdAt) / DAY),
          }
        : null,
      partial: reviews.capped,
    },
    aging: { deals: aging, partial: openPartial || open.length > 50 },
  };
}
