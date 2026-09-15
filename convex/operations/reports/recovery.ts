import { v } from "convex/values";
import { releaseAdmission, scheduleWorker } from "./admission";
import type { Doc } from "../../_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
} from "../../_generated/server";
import {
  REPORT_CLEANUP_BATCH_SIZE,
  REPORT_JOB_METADATA_RETENTION_MS,
  REPORT_MAX_AGE_MS,
  REPORT_MAX_RETRIES,
} from "./contracts";
import { ownerCanRunReport } from "./lifecycle";

const QUEUED_STALE_MS = 2 * 60_000;

export const recoverJob = internalMutation({
  args: {
    jobId: v.id("operationsReportJobs"),
    leaseGeneration: v.number(),
  },
  returns: v.object({ recovered: v.boolean(), reason: v.string() }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    const now = Date.now();
    if (job?.executionVersion === 2) return { recovered: false, reason: "Recovery is owned by maintenance." };
    if (
      !job ||
      (job.status !== "running" && job.status !== "rendering") ||
      job.leaseGeneration !== args.leaseGeneration ||
      job.leaseExpiresAt === undefined ||
      job.leaseExpiresAt > now
    ) {
      return { recovered: false, reason: "Lease is no longer stale." };
    }
    return await recoverStaleJob(ctx, job, now);
  },
});

export const recoverStaleReports = internalMutation({
  args: {},
  returns: v.object({ examined: v.number(), recovered: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const jobs: Doc<"operationsReportJobs">[] = [];
    for (const status of ["running", "rendering"] as const) {
      const matches = await ctx.db
        .query("operationsReportJobs")
        .withIndex("by_status_and_leaseExpiresAt", (q) =>
          q.eq("status", status).lte("leaseExpiresAt", now),
        )
        .take(REPORT_CLEANUP_BATCH_SIZE - jobs.length);
      jobs.push(...matches);
      if (jobs.length >= REPORT_CLEANUP_BATCH_SIZE) break;
    }
    if (jobs.length < REPORT_CLEANUP_BATCH_SIZE) {
      const queued = await ctx.db
        .query("operationsReportJobs")
        .withIndex("by_status_and_queuedAt", (q) =>
          q.eq("status", "queued").lte("queuedAt", now - QUEUED_STALE_MS),
        )
        .take(REPORT_CLEANUP_BATCH_SIZE - jobs.length);
      jobs.push(...queued);
    }

    let recovered = 0;
    for (const job of jobs) {
      if (job.executionVersion === 2 && job.scheduledFunctionId) {
        const invocation = await ctx.db.system.get(job.scheduledFunctionId);
        if (invocation?.state.kind === "pending" || invocation?.state.kind === "inProgress") continue;
      }
      const result =
        job.status === "queued"
          ? await recoverQueuedJob(ctx, job, now)
          : await recoverStaleJob(ctx, job, now);
      if (result.recovered) recovered += 1;
    }
    return { examined: jobs.length, recovered };
  },
});

async function recoverQueuedJob(
  ctx: MutationCtx,
  job: Doc<"operationsReportJobs">,
  now: number,
) {
  if (job.createdAt + REPORT_MAX_AGE_MS <= now) {
    await failRecovery(ctx, job, now, "Report exceeded its processing lifetime.");
    return { recovered: false, reason: "Maximum age exceeded." };
  }
  if (!(await ownerCanRunReport(ctx, job))) {
    await cancelRecovery(ctx, job, now);
    return { recovered: false, reason: "Owner access was revoked." };
  }
  if (job.retryCount >= REPORT_MAX_RETRIES) {
    await failRecovery(ctx, job, now, "Report could not be started after three retries.");
    return { recovered: false, reason: "Retry limit exceeded." };
  }
  return await requeue(ctx, job, now, "Queued invocation was not claimed.");
}

async function recoverStaleJob(
  ctx: MutationCtx,
  job: Doc<"operationsReportJobs">,
  now: number,
) {
  if (job.createdAt + REPORT_MAX_AGE_MS <= now) {
    await failRecovery(ctx, job, now, "Report exceeded its processing lifetime.");
    return { recovered: false, reason: "Maximum age exceeded." };
  }
  if (!(await ownerCanRunReport(ctx, job))) {
    await cancelRecovery(ctx, job, now);
    return { recovered: false, reason: "Owner access was revoked." };
  }
  if (job.retryCount >= REPORT_MAX_RETRIES) {
    await failRecovery(ctx, job, now, "Report lease expired after three retries.");
    return { recovered: false, reason: "Retry limit exceeded." };
  }
  return await requeue(ctx, job, now, "Worker lease expired.");
}

async function requeue(
  ctx: MutationCtx,
  job: Doc<"operationsReportJobs">,
  now: number,
  reason: string,
) {
  const retryCount = job.retryCount + 1;
  const delayMs = Math.min(60_000, 1_000 * 2 ** (retryCount - 1));
  const scheduledFunctionId = await scheduleWorker(ctx, job._id, delayMs);
  await ctx.db.patch(job._id, {
    status: "queued",
    queuedAt: now,
    retryCount,
    leaseGeneration: job.leaseGeneration + 1,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    scheduledFunctionId,
  });
  console.warn("[Operations:Reports] recovered", {
    jobId: job._id,
    retryCount,
    reason,
  });
  return { recovered: true, reason };
}

async function failRecovery(
  ctx: MutationCtx,
  job: Doc<"operationsReportJobs">,
  now: number,
  message: string,
) {
  await releaseAdmission(ctx, job);
  await ctx.db.patch(job._id, {
    status: "failed",
    phase: "cleanup",
    failure: { category: "recovery", message, retryable: false },
    completedAt: now,
    expiresAt: now,
    purgeAt: now + REPORT_JOB_METADATA_RETENTION_MS,
    cleanupPending: true,
    cleanupNextAttemptAt: now,
    leaseGeneration: job.leaseGeneration + 1,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    scheduledFunctionId: undefined,
  });
}

async function cancelRecovery(
  ctx: MutationCtx,
  job: Doc<"operationsReportJobs">,
  now: number,
) {
  await releaseAdmission(ctx, job);
  await ctx.db.patch(job._id, {
    status: "canceled",
    phase: "cleanup",
    failure: {
      category: "authorization",
      message: "Report owner no longer has access.",
      retryable: false,
    },
    canceledAt: now,
    completedAt: now,
    expiresAt: now,
    purgeAt: now + REPORT_JOB_METADATA_RETENTION_MS,
    cleanupPending: true,
    cleanupNextAttemptAt: now,
    leaseGeneration: job.leaseGeneration + 1,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    scheduledFunctionId: undefined,
  });
}
