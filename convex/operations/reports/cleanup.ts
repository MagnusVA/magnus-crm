import { v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../../_generated/server";
import { reportError } from "../../lib/observability/log";
import {
  REPORT_CLEANUP_BATCH_SIZE,
  REPORT_UPLOAD_SETTLE_MS,
} from "./contracts";

const STORAGE_PAGE_SIZE = 50;
/** First failed-delete attempt that gets reported; then every 10th after. */
const DELETE_FAILURE_REPORT_AFTER = 3;
const DELETE_FAILURE_REPORT_EVERY = 10;

function shouldReportDeleteFailure(deleteAttempts: number) {
  return (
    deleteAttempts >= DELETE_FAILURE_REPORT_AFTER &&
    (deleteAttempts - DELETE_FAILURE_REPORT_AFTER) %
      DELETE_FAILURE_REPORT_EVERY ===
      0
  );
}

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
      await ctx.db.patch("operationsReportJobs", job._id, {
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
      await ctx.db.patch("operationsReportArtifacts", artifact._id, {
        reservationExpiresAt: settleAt,
        reconciliationCursor: undefined,
        updatedAt: now,
      });
      return { examined: 1, progressed: true };
    }

    const job = await ctx.db.get("operationsReportJobs", artifact.jobId);
    if (
      job &&
      (job.status === "running" || job.status === "rendering") &&
      job.leaseExpiresAt !== undefined &&
      job.leaseExpiresAt > now
    ) {
      await ctx.db.patch("operationsReportArtifacts", artifact._id, {
        reservationExpiresAt: job.leaseExpiresAt + 1_000,
        updatedAt: now,
      });
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
      await ctx.db.patch("operationsReportArtifacts", artifact._id, {
        state: "attached",
        storageId: primaryStorageId,
        byteSize: artifact.expectedByteSize,
        attachedAt: artifact.attachedAt ?? now,
        reconciliationCursor: page.isDone ? undefined : page.continueCursor,
        reconciliationComplete: page.isDone,
        updatedAt: now,
      });
      if (attachedByReconciliation && job) {
        await ctx.db.patch("operationsReportJobs", job._id, {
          artifactCount: job.artifactCount + 1,
        });
      }
      return { examined: 1, progressed: true };
    }

    if (page.isDone) {
      await ctx.db.delete("operationsReportArtifacts", artifact._id);
    } else {
      await ctx.db.patch("operationsReportArtifacts", artifact._id, {
        reconciliationCursor: page.continueCursor,
        updatedAt: now,
      });
    }
    return { examined: 1, progressed: true };
  },
});

export const cleanupTerminalJobs = internalMutation({
  args: { jobId: v.optional(v.id("operationsReportJobs")) },
  returns: v.object({ examined: v.number(), deletedChildren: v.number() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const job = args.jobId ? await ctx.db.get("operationsReportJobs", args.jobId) : await ctx.db
      .query("operationsReportJobs")
      .withIndex("by_cleanupPending_and_cleanupNextAttemptAt", (q) =>
        q
          .eq("cleanupPending", true)
          .gt("cleanupNextAttemptAt", 0)
          .lte("cleanupNextAttemptAt", now),
      )
      .first();
    if (!job || !job.cleanupPending || (job.cleanupNextAttemptAt ?? Infinity) > now) return { examined: 0, deletedChildren: 0 };

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
            const deleteAttempts = artifact.deleteAttempts + 1;
            await ctx.db.patch("operationsReportArtifacts", artifact._id, {
              state: "delete_failed",
              deleteAttempts,
              lastDeleteError: sanitizeDeleteError(error),
              updatedAt: now,
            });
            // Retried every sweep forever, so report only the 3rd and then
            // every 10th consecutive failure.
            if (shouldReportDeleteFailure(deleteAttempts)) {
              reportError("reports.cleanup.storage_delete_failed", error, {
                severity: "warning",
                fingerprint: "reports.cleanup.storage_delete_failed",
                jobId: job._id,
                tenantId: job.tenantId,
                artifactId: artifact._id,
                deleteAttempts,
              });
            }
            continue;
          }
        }
        await ctx.db.delete("operationsReportArtifacts", artifact._id);
        deleted += 1;
      }
      if (deleted === 0) {
        await ctx.db.patch("operationsReportJobs", job._id, { cleanupNextAttemptAt: now + 60_000 });
      }
      return { examined: 1, deletedChildren: deleted };
    }

    const rows = await ctx.db
      .query("operationsReportRows")
      .withIndex("by_jobId_and_section_and_rowKey", (q) => q.eq("jobId", job._id))
      .take(REPORT_CLEANUP_BATCH_SIZE);
    if (rows.length > 0) {
      for (const row of rows) await ctx.db.delete("operationsReportRows", row._id);
      return { examined: 1, deletedChildren: rows.length };
    }

    const checkpoints = await ctx.db
      .query("operationsReportCheckpoints")
      .withIndex("by_jobId_and_sourceKey", (q) => q.eq("jobId", job._id))
      .take(REPORT_CLEANUP_BATCH_SIZE);
    if (checkpoints.length > 0) {
      for (const checkpoint of checkpoints) await ctx.db.delete("operationsReportCheckpoints", checkpoint._id);
      return { examined: 1, deletedChildren: checkpoints.length };
    }

    await ctx.db.patch("operationsReportJobs", job._id, {
      cleanupPending: false,
      cleanupNextAttemptAt: undefined,
      cleanupCompletedAt: now,
    });
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
      await ctx.db.delete("operationsReportJobs", job._id);
      purged += 1;
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
    .withIndex("by_jobId_and_section_and_rowKey", (q) => q.eq("jobId", jobId))
    .first();
  if (row) return true;
  const checkpoint = await ctx.db
    .query("operationsReportCheckpoints")
    .withIndex("by_jobId_and_sourceKey", (q) => q.eq("jobId", jobId))
    .first();
  return Boolean(checkpoint);
}

function sanitizeDeleteError(error: unknown) {
  const message = error instanceof Error ? error.message : "Storage deletion failed.";
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}


export const pendingCleanupJobs = internalQuery({
  args: { now: v.number() },
  returns: v.array(v.id("operationsReportJobs")),
  handler: async (ctx, { now }) => (await ctx.db.query("operationsReportJobs").withIndex("by_cleanupPending_and_cleanupNextAttemptAt", q => q.eq("cleanupPending", true).gt("cleanupNextAttemptAt", 0).lte("cleanupNextAttemptAt", now)).take(REPORT_CLEANUP_BATCH_SIZE)).map(job => job._id),
});
