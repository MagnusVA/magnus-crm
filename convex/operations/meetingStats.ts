import { v, type Infer } from "convex/values";
import { vOnCompleteArgs } from "@convex-dev/workpool";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { reportingPool } from "../pipeline/workpools";
import { meetingContribution } from "./meetingProjectionSchema";

type Contribution = Infer<typeof meetingContribution>;
export function meetingDayKey(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}
export function bucketKey(c: Contribution) {
  return JSON.stringify([
    c.dayKey,
    c.assignedCloserId,
    c.bookingProgramId ?? null,
    c.soldProgramId ?? null,
    c.attributionTeamId ?? null,
    c.dmCloserId ?? null,
    c.opportunityStatus ?? null,
    c.meetingStatus,
  ]);
}
async function increment(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  c: Contribution,
  delta: 1 | -1,
) {
  const key = bucketKey(c);
  const row = await ctx.db
    .query("operationsMeetingStatsV2")
    .withIndex("by_tenantId_and_bucketKey", (q) =>
      q.eq("tenantId", tenantId).eq("bucketKey", key),
    )
    .unique();
  if (!row) {
    if (delta < 0) throw new Error("Missing recorded meeting contribution");
    await ctx.db.insert("operationsMeetingStatsV2", {
      tenantId,
      ...c,
      bucketKey: key,
      count: 1,
      updatedAt: Date.now(),
    });
  } else if (row.count + delta === 0) {
    await ctx.db.delete("operationsMeetingStatsV2", row._id);
  } else {
    await ctx.db.patch("operationsMeetingStatsV2", row._id, {
      count: row.count + delta,
      updatedAt: Date.now(),
    });
  }
}

/** Record the obligation in the source transaction. Jobs contain IDs, never snapshots. */
export async function requestMeetingProjection(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  meetingId: Id<"meetings">,
) {
  const row = await ctx.db
    .query("meetingProjections")
    .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
    .unique();
  if (row && row.tenantId !== tenantId)
    throw new Error("Projection tenant mismatch");
  // A pending job always reads the latest state. Repeated changes coalesce.
  if (row?.status === "queued") return;
  const generation = (row?.generation ?? 0) + 1;
  const fields = {
    generation,
    status: "queued" as const,
    requestedAt: Date.now(),
    reason: undefined,
  };
  const projectionId =
    row?._id ??
    (await ctx.db.insert("meetingProjections", {
      tenantId,
      meetingId,
      ...fields,
    }));
  if (row) await ctx.db.patch("meetingProjections", row._id, fields);
  await reportingPool.enqueueMutation(
    ctx,
    internal.operations.meetingStats.project,
    { projectionId, generation },
    {
      onComplete: internal.operations.meetingStats.completed,
      context: { projectionId, generation },
    },
  );
}

export const project = internalMutation({
  args: { projectionId: v.id("meetingProjections"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, { projectionId, generation }) => {
    const projection = await ctx.db.get("meetingProjections", projectionId);
    if (
      !projection ||
      projection.generation !== generation ||
      projection.status !== "queued"
    )
      return null;
    const meeting = await ctx.db.get("meetings", projection.meetingId);
    let next: Contribution | undefined;
    if (meeting) {
      const opportunity = await ctx.db.get(
        "opportunities",
        meeting.opportunityId,
      );
      if (
        meeting.tenantId !== projection.tenantId ||
        !opportunity ||
        opportunity.tenantId !== meeting.tenantId
      )
        throw new Error("Invalid meeting relationship");
      next = {
        dayKey: meetingDayKey(meeting.scheduledAt),
        assignedCloserId: meeting.assignedCloserId,
        bookingProgramId: meeting.bookingProgramId,
        soldProgramId: opportunity.soldProgramId,
        attributionTeamId: meeting.attributionTeamId,
        dmCloserId: meeting.dmCloserId,
        opportunityStatus: opportunity.status,
        meetingStatus: meeting.status,
      };
      if (
        meeting.opportunityStatus !== opportunity.status ||
        meeting.soldProgramId !== opportunity.soldProgramId ||
        meeting.soldProgramName !== opportunity.soldProgramName
      ) {
        await ctx.db.patch("meetings", meeting._id, {
          opportunityStatus: opportunity.status,
          soldProgramId: opportunity.soldProgramId,
          soldProgramName: opportunity.soldProgramName,
        });
      }
    }
    const old = projection.contribution;
    if ((old && bucketKey(old)) !== (next && bucketKey(next))) {
      // Sequential writes matter when two changes touch the same bucket.
      if (old) await increment(ctx, projection.tenantId, old, -1);
      if (next) await increment(ctx, projection.tenantId, next, 1);
    }
    await ctx.db.patch("meetingProjections", projectionId, {
      contribution: next,
      bucketKey: next ? bucketKey(next) : undefined,
      status: "applied",
      appliedAt: Date.now(),
      reason: undefined,
    });
    return null;
  },
});
export const completed = internalMutation({
  args: vOnCompleteArgs(
    v.object({
      projectionId: v.id("meetingProjections"),
      generation: v.number(),
    }),
  ),
  returns: v.null(),
  handler: async (ctx, { context, result }) => {
    const row = await ctx.db.get("meetingProjections", context.projectionId);
    if (row?.generation === context.generation && row.status === "queued") {
      await ctx.db.patch("meetingProjections", row._id, {
        status: "failed",
        reason:
          result.kind === "canceled" ? "work_canceled" : "projection_failed",
      });
    }
    return null;
  },
});

/** Compatibility entry points for migrations and existing metadata writers. */
export async function insertOperationsMeetingStats(
  ctx: MutationCtx,
  meeting: Doc<"meetings">,
) {
  await requestMeetingProjection(ctx, meeting.tenantId, meeting._id);
}
export async function replaceOperationsMeetingStats(
  ctx: MutationCtx,
  _before: Doc<"meetings">,
  meeting: Doc<"meetings">,
) {
  await requestMeetingProjection(ctx, meeting.tenantId, meeting._id);
}

async function enqueueOpportunityPage(
  ctx: MutationCtx,
  job: Doc<"opportunityProjectionJobs">,
) {
  const generation = job.generation + 1;
  await ctx.db.patch("opportunityProjectionJobs", job._id, {
    generation,
    status: "queued",
    reason: undefined,
  });
  await reportingPool.enqueueMutation(
    ctx,
    internal.operations.meetingStats.projectOpportunityPage,
    { jobId: job._id, generation },
    {
      onComplete: internal.operations.meetingStats.opportunityPageCompleted,
      context: { jobId: job._id, generation },
    },
  );
}
export async function requestOpportunityProjections(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
) {
  const opportunity = await ctx.db.get("opportunities", opportunityId);
  if (!opportunity) throw new Error("Opportunity missing");
  const existing = await ctx.db
    .query("opportunityProjectionJobs")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
    .unique();
  if (existing?.status === "queued") {
    await ctx.db.patch("opportunityProjectionJobs", existing._id, {
      dirty: true,
    });
    return;
  }
  const id =
    existing?._id ??
    (await ctx.db.insert("opportunityProjectionJobs", {
      tenantId: opportunity.tenantId,
      opportunityId,
      generation: 0,
      status: "queued",
      cursor: null,
      dirty: false,
      requestedAt: Date.now(),
    }));
  await ctx.db.patch("opportunityProjectionJobs", id, {
    cursor: null,
    dirty: false,
    requestedAt: Date.now(),
  });
  await enqueueOpportunityPage(
    ctx,
    (await ctx.db.get("opportunityProjectionJobs", id))!,
  );
}
export const projectOpportunityPage = internalMutation({
  args: { jobId: v.id("opportunityProjectionJobs"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, { jobId, generation }) => {
    const job = await ctx.db.get("opportunityProjectionJobs", jobId);
    if (!job || job.generation !== generation || job.status !== "queued")
      return null;
    const page = await ctx.db
      .query("meetings")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", job.opportunityId),
      )
      .paginate({ cursor: job.cursor, numItems: 64 });
    for (const meeting of page.page) {
      if (meeting.tenantId !== job.tenantId)
        throw new Error("Meeting tenant mismatch");
      await requestMeetingProjection(ctx, meeting.tenantId, meeting._id);
    }
    if (!page.isDone || job.dirty) {
      await ctx.db.patch("opportunityProjectionJobs", jobId, {
        cursor: page.isDone ? null : page.continueCursor,
        dirty: page.isDone ? false : job.dirty,
      });
      await enqueueOpportunityPage(
        ctx,
        (await ctx.db.get("opportunityProjectionJobs", jobId))!,
      );
    } else
      await ctx.db.patch("opportunityProjectionJobs", jobId, {
        status: "applied",
      });
    return null;
  },
});
export const opportunityPageCompleted = internalMutation({
  args: vOnCompleteArgs(
    v.object({
      jobId: v.id("opportunityProjectionJobs"),
      generation: v.number(),
    }),
  ),
  returns: v.null(),
  handler: async (ctx, { context, result }) => {
    const job = await ctx.db.get("opportunityProjectionJobs", context.jobId);
    if (
      job?.generation === context.generation &&
      job.status === "queued" &&
      result.kind !== "success"
    ) {
      await ctx.db.patch("opportunityProjectionJobs", job._id, {
        status: "failed",
        reason: "fanout_failed",
      });
    }
    return null;
  },
});
