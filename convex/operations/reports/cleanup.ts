import { v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
} from "../../_generated/server";
import {
  REPORT_CLEANUP_BATCH_SIZE,
  REPORT_UPLOAD_SETTLE_MS,
} from "./contracts";

const STORAGE_PAGE_SIZE = 50;

export const expireReadyJobs = internalMutation({
  args: {},
  returns: v.object({ expired: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const jobs = await ctx.db
      .query("operationsReportJobs")
      .withIndex("by_status_and_expiresAt", (q) =>
        q.eq("status", "ready").lte("expiresAt", now),
      )
      .take(REPORT_CLEANUP_BATCH_SIZE);
    let expired = 0;
    for (const job of jobs) {
      if (job.status !== "ready") continue;
      await ctx.db.patch(job._id, {
        status: "expired",
        phase: "cleanup",
        cleanupPending: true,
        cleanupNextAttemptAt: now,
        cleanupStartedAt: now,
        leaseGeneration: job.leaseGeneration + 1,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        scheduledFunctionId: undefined,
      });
      expired += 1;
    }
    if (expired > 0) await scheduleCleanupContinuation(ctx);
    if (jobs.length === REPORT_CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.operations.reports.cleanup.expireReadyJobs, {});
    }
    return { expired };
  },
});

export const reconcileOrphanReservations = internalMutation({
  args: {},
  returns: v.object({ examined: v.number(), progressed: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    const artifact = await ctx.db
      .query("operationsReportArtifacts")
      .withIndex("by_reconciliationComplete_and_reservationExpiresAt", (q) =>
        q.eq("reconciliationComplete", false).lte("reservationExpiresAt", now),
      )
      .first();
    if (!artifact) return { examined: 0, progressed: false };

    // Also protect reservations created before the longer settle window shipped.
    // Lease expiry cannot prove that an in-flight storage upload has finished.
    const settleAt = artifact.reservedAt + REPORT_UPLOAD_SETTLE_MS;
    if (settleAt > now) {
      await ctx.db.patch(artifact._id, {
        reservationExpiresAt: settleAt,
        reconciliationCursor: undefined,
        updatedAt: now,
      });
      await scheduleReconciliationContinuation(ctx, settleAt - now);
      await scheduleReconciliationContinuation(ctx);
      return { examined: 1, progressed: true };
    }

    const job = await ctx.db.get(artifact.jobId);
    if (
      job &&
      (job.status === "running" || job.status === "rendering") &&
      job.leaseExpiresAt !== undefined &&
      job.leaseExpiresAt > now
    ) {
      await ctx.db.patch(artifact._id, {
        reservationExpiresAt: job.leaseExpiresAt + 1_000,
        updatedAt: now,
      });
      await scheduleReconciliationContinuation(
        ctx,
        job.leaseExpiresAt + 1_000 - now,
      );
      return { examined: 1, progressed: true };
    }

    const page = await ctx.db.system
      .query("_storage")
      .withIndex("by_creation_time", (q) =>
        q
          .gte("_creationTime", artifact.reservedAt)
          .lte("_creationTime", artifact.reservationExpiresAt),
      )
      .order("asc")
      .paginate({
        cursor: artifact.reconciliationCursor ?? null,
        numItems: STORAGE_PAGE_SIZE,
        maximumRowsRead: STORAGE_PAGE_SIZE,
        maximumBytesRead: 1_048_576,
      });
    const preservePrimary = Boolean(
      job &&
        (job.status === "queued" ||
          job.status === "running" ||
          job.status === "rendering" ||
          job.status === "ready"),
    );
    let primaryStorageId = artifact.storageId;
    let attachedByReconciliation = false;

    for (const storage of page.page) {
      if (!matchesReservation(storage, artifact)) continue;
      if (preservePrimary && primaryStorageId === undefined) {
        primaryStorageId = storage._id;
        attachedByReconciliation = artifact.state !== "attached";
        continue;
      }
      if (preservePrimary && storage._id === primaryStorageId) continue;
      await ctx.storage.delete(storage._id);
    }

    if (preservePrimary && primaryStorageId !== undefined) {
      await ctx.db.patch(artifact._id, {
        state: "attached",
        storageId: primaryStorageId,
        byteSize: artifact.expectedByteSize,
        attachedAt: artifact.attachedAt ?? now,
        reconciliationCursor: page.isDone ? undefined : page.continueCursor,
        reconciliationComplete: page.isDone,
        updatedAt: now,
      });
      if (attachedByReconciliation && job) {
        await ctx.db.patch(job._id, {
          artifactCount: job.artifactCount + 1,
        });
      }
      await scheduleReconciliationContinuation(ctx);
      return { examined: 1, progressed: true };
    }

    if (page.isDone) {
      await ctx.db.delete(artifact._id);
      await scheduleReconciliationContinuation(ctx);
    } else {
      await ctx.db.patch(artifact._id, {
        reconciliationCursor: page.continueCursor,
        updatedAt: now,
      });
      await scheduleReconciliationContinuation(ctx);
    }
    return { examined: 1, progressed: true };
  },
});

export const cleanupTerminalJobs = internalMutation({
  args: {},
  returns: v.object({ examined: v.number(), deletedChildren: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const job = await ctx.db
      .query("operationsReportJobs")
      .withIndex("by_cleanupPending_and_cleanupNextAttemptAt", (q) =>
        q
          .eq("cleanupPending", true)
          .gt("cleanupNextAttemptAt", 0)
          .lte("cleanupNextAttemptAt", now),
      )
      .first();
    if (!job) return { examined: 0, deletedChildren: 0 };

    const artifacts = await ctx.db
      .query("operationsReportArtifacts")
      .withIndex("by_jobId_and_partNumber", (q) => q.eq("jobId", job._id))
      .take(REPORT_CLEANUP_BATCH_SIZE);
    if (artifacts.length > 0) {
      let deleted = 0;
      for (const artifact of artifacts) {
        if (!artifact.reconciliationComplete) continue;
        if (artifact.storageId) {
          try {
            await ctx.storage.delete(artifact.storageId);
          } catch (error) {
            await ctx.db.patch(artifact._id, {
              state: "delete_failed",
              deleteAttempts: artifact.deleteAttempts + 1,
              lastDeleteError: sanitizeDeleteError(error),
              updatedAt: now,
            });
            continue;
          }
        }
        await ctx.db.delete(artifact._id);
        deleted += 1;
      }
      if (deleted === 0) {
        await ctx.db.patch(job._id, { cleanupNextAttemptAt: now + 60_000 });
        await scheduleCleanupContinuation(ctx, 60_000);
        await ctx.scheduler.runAfter(
          0,
          internal.operations.reports.cleanup.reconcileOrphanReservations,
          {},
        );
      }
      await scheduleCleanupContinuation(ctx);
      return { examined: 1, deletedChildren: deleted };
    }

    const rows = await ctx.db
      .query("operationsReportRows")
      .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
      .take(REPORT_CLEANUP_BATCH_SIZE);
    if (rows.length > 0) {
      for (const row of rows) await ctx.db.delete(row._id);
      await scheduleCleanupContinuation(ctx);
      return { examined: 1, deletedChildren: rows.length };
    }

    const checkpoints = await ctx.db
      .query("operationsReportCheckpoints")
      .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
      .take(REPORT_CLEANUP_BATCH_SIZE);
    if (checkpoints.length > 0) {
      for (const checkpoint of checkpoints) await ctx.db.delete(checkpoint._id);
      await scheduleCleanupContinuation(ctx);
      return { examined: 1, deletedChildren: checkpoints.length };
    }

    await ctx.db.patch(job._id, {
      cleanupPending: false,
      cleanupNextAttemptAt: undefined,
      cleanupCompletedAt: now,
    });
    await scheduleCleanupContinuation(ctx);
    return { examined: 1, deletedChildren: 0 };
  },
});

export const purgeExpiredMetadata = internalMutation({
  args: {},
  returns: v.object({ examined: v.number(), purged: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const jobs = await ctx.db
      .query("operationsReportJobs")
      .withIndex("by_cleanupPending_and_purgeAt", (q) =>
        q
          .eq("cleanupPending", false)
          .gt("purgeAt", 0)
          .lte("purgeAt", now),
      )
      .take(REPORT_CLEANUP_BATCH_SIZE);
    let purged = 0;
    for (const job of jobs) {
      if (job.cleanupPending || job.cleanupCompletedAt === undefined) continue;
      const child = await firstJobChild(ctx, job._id);
      if (child) continue;
      await ctx.db.delete(job._id);
      purged += 1;
    }
    // Continue only after progress so malformed metadata cannot cause a busy loop.
    if (jobs.length === REPORT_CLEANUP_BATCH_SIZE && purged > 0) {
      await ctx.scheduler.runAfter(0, internal.operations.reports.cleanup.purgeExpiredMetadata, {});
    }
    return { examined: jobs.length, purged };
  },
});

function matchesReservation(
  storage: {
    _id: Id<"_storage">;
    _creationTime: number;
    contentType?: string;
    sha256: string;
    size: number;
  },
  artifact: Doc<"operationsReportArtifacts">,
) {
  return (
    storage._creationTime >= artifact.reservedAt &&
    storage._creationTime <= artifact.reservationExpiresAt &&
    storage.contentType === artifact.ownershipContentType &&
    storage.sha256 === artifact.expectedSha256 &&
    storage.size === artifact.expectedByteSize
  );
}

async function firstJobChild(
  ctx: MutationCtx,
  jobId: Id<"operationsReportJobs">,
) {
  const artifact = await ctx.db
    .query("operationsReportArtifacts")
    .withIndex("by_jobId_and_partNumber", (q) => q.eq("jobId", jobId))
    .first();
  if (artifact) return true;
  const row = await ctx.db
    .query("operationsReportRows")
    .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
    .first();
  if (row) return true;
  const checkpoint = await ctx.db
    .query("operationsReportCheckpoints")
    .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
    .first();
  return Boolean(checkpoint);
}

function sanitizeDeleteError(error: unknown) {
  const message = error instanceof Error ? error.message : "Storage deletion failed.";
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}

async function scheduleCleanupContinuation(ctx: MutationCtx, delayMs = 0) {
  await ctx.scheduler.runAfter(
    delayMs,
    internal.operations.reports.cleanup.cleanupTerminalJobs,
    {},
  );
}

async function scheduleReconciliationContinuation(
  ctx: MutationCtx,
  delayMs = 0,
) {
  await ctx.scheduler.runAfter(
    Math.max(0, delayMs),
    internal.operations.reports.cleanup.reconcileOrphanReservations,
    {},
  );
}
