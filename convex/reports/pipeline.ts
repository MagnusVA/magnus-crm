import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { readLiveQueryRows } from "../lib/liveQueryBounds";
import {
  OPEN_PIPELINE_STAGES,
  readPipelineDistributionByStage,
  type OpenPipelineStage,
} from "../reporting/pipelineHealth";
import { getUserDisplayName } from "../reporting/lib/helpers";
import { requireTenantUser } from "../requireTenantUser";
import { REPORT_ADMIN_ROLES } from "./lib/access";
import { loadCallFacts } from "./lib/callFacts";

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
    total: number;
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
    total: v.number(),
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

export const getPipelineNow = query({
  returns: pipelineNowValidator,
  args: {},
  handler: async (ctx): Promise<PipelineNow> => {
    const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
    const now = Date.now();
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
      const callAt = deal.nextMeetingAt;
      const taskAt =
        task?.tenantId === tenantId ? (task.reminderScheduledAt ?? null) : null;
      const step =
        callAt !== undefined &&
        callAt >= now &&
        (taskAt === null || callAt <= taskAt)
          ? { kind: "call" as const, at: callAt }
          : task?.tenantId === tenantId
            ? { kind: "task" as const, at: taskAt }
            : null;
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
    // Counts need only the bounded meeting scan; enrich just the visible list.
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
        total: due.length,
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
        partial: scheduled.capped || owedFacts.partial || due.length > 100,
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
  },
});
