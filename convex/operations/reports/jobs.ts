import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../../_generated/server";
import { requireTenantUser } from "../../requireTenantUser";
import {
  REPORT_DEFINITION_VERSION,
  REPORT_JOB_METADATA_RETENTION_MS,
  REPORT_LEASE_MS,
  REPORT_UPLOAD_SETTLE_MS,
  REPORT_MAX_ARTIFACT_BYTES,
  REPORT_MAX_AGE_MS,
  REPORT_MAX_PUBLIC_PAGE_SIZE,
  REPORT_READY_LIFETIME_MS,
  activeReportStatuses,
  artifactStateValidator,
  assertBoundedIdentifier,
  assertValidReportFormat,
  assertValidSourceFilter,
  buildReportRequestKey,
  normalizeReportRange,
  normalizedReportRangeValidator,
  reportContributionValidator,
  reportFailureValidator,
  reportFormatValidator,
  reportKindValidator,
  reportPhaseValidator,
  reportPurposeValidator,
  reportRangeInputValidator,
  reportResultWriteValidator,
  reportSourceFilterValidator,
  reportStatusValidator,
  scalarRecordValidator,
  type ReportFormat,
  type ReportKind,
  type ReportPurpose,
  type ReportRangeInput,
  type ReportSourceFilter,
} from "./contracts";
import {
  applyFinalizedRows,
  applyReportContributions,
  assertBatchSize,
  assertNonNegativeInteger,
  getJobCheckpoint,
  hasActiveLease,
  ownerCanRunReport,
} from "./lifecycle";

const ADMIN_ROLES = ["tenant_master", "tenant_admin"] as const;

const requestResultValidator = v.object({
  jobId: v.id("operationsReportJobs"),
  requestKey: v.string(),
});

const reportJobPublicValidator = v.object({
  jobId: v.id("operationsReportJobs"),
  purpose: reportPurposeValidator,
  reportKind: reportKindValidator,
  format: v.optional(reportFormatValidator),
  range: normalizedReportRangeValidator,
  sourceFilter: reportSourceFilterValidator,
  requestKey: v.string(),
  definitionVersion: v.string(),
  status: reportStatusValidator,
  phase: reportPhaseValidator,
  rowsProcessed: v.number(),
  pagesProcessed: v.number(),
  artifactCount: v.number(),
  retryCount: v.number(),
  queuedAt: v.number(),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  expiresAt: v.optional(v.number()),
  failure: v.optional(reportFailureValidator),
});

const reportJobInternalValidator = v.object({
  jobId: v.id("operationsReportJobs"),
  tenantId: v.id("tenants"),
  requestedByUserId: v.id("users"),
  purpose: reportPurposeValidator,
  reportKind: reportKindValidator,
  format: v.optional(reportFormatValidator),
  range: normalizedReportRangeValidator,
  sourceFilter: reportSourceFilterValidator,
  definitionVersion: v.string(),
  status: reportStatusValidator,
  phase: reportPhaseValidator,
  rowsProcessed: v.number(),
  pagesProcessed: v.number(),
  artifactCount: v.number(),
  checkpointSequence: v.number(),
  leaseGeneration: v.number(),
  leaseOwner: v.optional(v.string()),
  leaseExpiresAt: v.optional(v.number()),
  retryCount: v.number(),
  createdAt: v.number(),
  startedAt: v.optional(v.number()),
});

const checkpointPublicValidator = v.object({
  sourceKey: v.string(),
  cursor: v.optional(v.string()),
  splitCursor: v.optional(v.string()),
  sequence: v.number(),
  completed: v.boolean(),
  rowsProcessed: v.number(),
  renderPosition: v.optional(v.number()),
  lastCommitKey: v.optional(v.string()),
});

const resultRowValidator = v.object({
  rowId: v.id("operationsReportRows"),
  section: v.string(),
  rowKey: v.string(),
  payload: scalarRecordValidator,
  groupKey: v.optional(v.string()),
  sortValue: v.optional(v.number()),
});

const artifactPublicValidator = v.object({
  artifactId: v.id("operationsReportArtifacts"),
  partNumber: v.number(),
  filename: v.string(),
  mimeType: v.string(),
  byteSize: v.number(),
  rowCount: v.number(),
  available: v.boolean(),
});

const commitResultValidator = v.union(
  v.object({ kind: v.literal("committed"), sequence: v.number() }),
  v.object({ kind: v.literal("already_committed"), sequence: v.number() }),
  v.object({
    kind: v.literal("stale"),
    sequence: v.number(),
    reason: v.string(),
  }),
);

export const requestDashboardReport = mutation({
  args: {
    reportKind: reportKindValidator,
    range: reportRangeInputValidator,
    sourceFilter: v.optional(reportSourceFilterValidator),
    requestToken: v.string(),
  },
  returns: requestResultValidator,
  handler: async (ctx, args) =>
    await requestReport(ctx, {
      purpose: "dashboard",
      reportKind: args.reportKind,
      range: args.range,
      sourceFilter: args.sourceFilter ?? "all",
      requestToken: args.requestToken,
    }),
});

export const requestExport = mutation({
  args: {
    reportKind: reportKindValidator,
    format: reportFormatValidator,
    range: reportRangeInputValidator,
    sourceFilter: v.optional(reportSourceFilterValidator),
    requestToken: v.string(),
  },
  returns: requestResultValidator,
  handler: async (ctx, args) =>
    await requestReport(ctx, {
      purpose: "export",
      reportKind: args.reportKind,
      format: args.format,
      range: args.range,
      sourceFilter: args.sourceFilter ?? "all",
      requestToken: args.requestToken,
    }),
});

export const getReportJob = query({
  args: { jobId: v.id("operationsReportJobs") },
  returns: reportJobPublicValidator,
  handler: async (ctx, args) => {
    const job = await requireOwnedJob(ctx, args.jobId);
    return toPublicJob(job);
  },
});

export const getDashboardReportSummary = query({
  args: { jobId: v.id("operationsReportJobs") },
  returns: v.union(v.null(), v.object({
    jobId: v.id("operationsReportJobs"),
    reportKind: reportKindValidator,
    range: normalizedReportRangeValidator,
    sourceFilter: reportSourceFilterValidator,
    generatedAt: v.number(),
    payload: scalarRecordValidator,
  })),
  handler: async (ctx, args) => {
    const job = await requireOwnedJob(ctx, args.jobId);
    if (job.definitionVersion !== REPORT_DEFINITION_VERSION) return null;
    assertReadyDashboard(job);
    const summary = await ctx.db
      .query("operationsReportRows")
      .withIndex("by_jobId_and_section_and_rowType_and_rowKey", (q) =>
        q
          .eq("jobId", job._id)
          .eq("section", summarySection(job.reportKind))
          .eq("rowType", "result")
          .eq("rowKey", "main"),
      )
      .unique();
    if (!summary || job.completedAt === undefined) {
      throw new Error("The report summary has not been published.");
    }
    return {
      jobId: job._id,
      reportKind: job.reportKind,
      range: job.range,
      sourceFilter: job.sourceFilter,
      generatedAt: job.completedAt,
      payload: summary.payload,
    };
  },
});

export const listDashboardReportRows = query({
  args: {
    jobId: v.id("operationsReportJobs"),
    section: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(resultRowValidator),
  handler: async (ctx, args) => {
    const job = await requireOwnedJob(ctx, args.jobId);
    assertReadyDashboard(job);
    // Published rows are immutable while ready. This keeps manual reactive
    // pages stable; any future mutable results must support page splitting.
    const section = assertBoundedIdentifier(args.section, "Report section");
    if (section.startsWith("__") || section === summarySection(job.reportKind)) {
      throw new Error("This report section is not pageable.");
    }
    const page = await ctx.db
      .query("operationsReportRows")
      .withIndex("by_jobId_and_section_and_rowType_and_sortValue", (q) =>
        q
          .eq("jobId", job._id)
          .eq("section", section)
          .eq("rowType", "result"),
      )
      .order("desc")
      .paginate(clampPublicPagination(args.paginationOpts));
    return {
      ...page,
      page: page.page.map(toPublicResultRow),
    };
  },
});

export const listReportArtifacts = query({
  args: {
    jobId: v.id("operationsReportJobs"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(artifactPublicValidator),
  handler: async (ctx, args) => {
    const job = await requireOwnedJob(ctx, args.jobId);
    if (job.purpose !== "export" || job.status !== "ready") {
      throw new Error("Report artifacts are available only for a ready export.");
    }
    // The complete manifest is immutable until the job leaves ready status.
    const page = await ctx.db
      .query("operationsReportArtifacts")
      .withIndex("by_jobId_and_partNumber", (q) => q.eq("jobId", job._id))
      .paginate(clampPublicPagination(args.paginationOpts));
    return {
      ...page,
      page: page.page.map((artifact) => ({
        artifactId: artifact._id,
        partNumber: artifact.partNumber,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        byteSize: artifact.byteSize ?? artifact.expectedByteSize,
        rowCount: artifact.rowCount,
        available: artifact.state === "attached" && artifact.storageId !== undefined,
      })),
    };
  },
});

export const requestReportDownload = mutation({
  args: {
    jobId: v.id("operationsReportJobs"),
    artifactId: v.id("operationsReportArtifacts"),
  },
  returns: v.object({
    url: v.string(),
    filename: v.string(),
    mimeType: v.string(),
    byteSize: v.number(),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const job = await requireOwnedJob(ctx, args.jobId);
    const now = Date.now();
    if (
      job.purpose !== "export" ||
      job.status !== "ready" ||
      job.expiresAt === undefined ||
      job.expiresAt <= now
    ) {
      throw new Error("This report download is no longer available.");
    }
    const artifact = await ctx.db.get(args.artifactId);
    if (
      !artifact ||
      artifact.jobId !== job._id ||
      artifact.tenantId !== job.tenantId ||
      artifact.state !== "attached" ||
      artifact.storageId === undefined
    ) {
      throw new Error("Report artifact not found.");
    }
    const url = await ctx.storage.getUrl(artifact.storageId);
    if (!url) {
      throw new Error("The report file is no longer available.");
    }
    return {
      url,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      byteSize: artifact.byteSize ?? artifact.expectedByteSize,
      expiresAt: job.expiresAt,
    };
  },
});

export const cancelReport = mutation({
  args: { jobId: v.id("operationsReportJobs") },
  returns: v.object({ status: reportStatusValidator }),
  handler: async (ctx, args) => {
    const job = await requireOwnedJob(ctx, args.jobId);
    if (!activeReportStatuses.includes(job.status as (typeof activeReportStatuses)[number])) {
      return { status: job.status };
    }
    if (job.scheduledFunctionId) {
      await ctx.scheduler.cancel(job.scheduledFunctionId);
    }
    const now = Date.now();
    await ctx.db.patch(job._id, {
      status: "canceled",
      phase: "cleanup",
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
    console.log("[Operations:Reports] canceled", { jobId: job._id });
    return { status: "canceled" as const };
  },
});

export const getJobState = internalQuery({
  args: { jobId: v.id("operationsReportJobs") },
  returns: v.union(v.null(), reportJobInternalValidator),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    return job ? toInternalJob(job) : null;
  },
});

export const getCheckpoint = internalQuery({
  args: {
    jobId: v.id("operationsReportJobs"),
    sourceKey: v.string(),
  },
  returns: v.union(v.null(), checkpointPublicValidator),
  handler: async (ctx, args) => {
    const checkpoint = await getJobCheckpoint(ctx, args.jobId, args.sourceKey);
    return checkpoint ? toPublicCheckpoint(checkpoint) : null;
  },
});

export const listResultRowsInternal = internalQuery({
  args: {
    jobId: v.id("operationsReportJobs"),
    section: v.string(),
    rowType: v.union(v.literal("staging"), v.literal("result")),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(resultRowValidator),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) {
      throw new Error("Report job not found.");
    }
    const page = await ctx.db
      .query("operationsReportRows")
      .withIndex("by_jobId_and_section_and_rowType_and_rowKey", (q) =>
        q
          .eq("jobId", job._id)
          .eq("section", args.section)
          .eq("rowType", args.rowType),
      )
      .paginate(args.paginationOpts);
    return { ...page, page: page.page.map(toPublicResultRow) };
  },
});

export const getArtifactForRender = internalQuery({
  args: {
    jobId: v.id("operationsReportJobs"),
    partNumber: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({
      artifactId: v.id("operationsReportArtifacts"),
      partNumber: v.number(),
      filename: v.string(),
      mimeType: v.string(),
      ownershipContentType: v.string(),
      state: artifactStateValidator,
      storageId: v.optional(v.id("_storage")),
      expectedSha256: v.string(),
      expectedByteSize: v.number(),
      rowCount: v.number(),
      ownershipToken: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const artifact = await ctx.db
      .query("operationsReportArtifacts")
      .withIndex("by_jobId_and_partNumber", (q) =>
        q.eq("jobId", args.jobId).eq("partNumber", args.partNumber),
      )
      .unique();
    return artifact
      ? {
          artifactId: artifact._id,
          partNumber: artifact.partNumber,
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          ownershipContentType: artifact.ownershipContentType,
          state: artifact.state,
          storageId: artifact.storageId,
          expectedSha256: artifact.expectedSha256,
          expectedByteSize: artifact.expectedByteSize,
          rowCount: artifact.rowCount,
          ownershipToken: artifact.ownershipToken,
        }
      : null;
  },
});

export const claimJob = internalMutation({
  args: {
    jobId: v.id("operationsReportJobs"),
    workerId: v.string(),
  },
  returns: v.union(
    v.object({
      kind: v.literal("claimed"),
      leaseGeneration: v.number(),
      checkpointSequence: v.number(),
      status: reportStatusValidator,
    }),
    v.object({ kind: v.literal("skip"), reason: v.string() }),
  ),
  handler: async (ctx, args) => {
    const workerId = assertBoundedIdentifier(args.workerId, "Worker ID");
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "queued") {
      return { kind: "skip" as const, reason: "Job is not queued." };
    }
    const now = Date.now();
    if (job.definitionVersion !== REPORT_DEFINITION_VERSION) {
      await markJobFailed(ctx, job, now, {
        category: "definition_version",
        message: "This report was created with an older definition. Regenerate the report.",
        retryable: false,
      });
      return { kind: "skip" as const, reason: "Report definition is outdated." };
    }
    if (job.createdAt + REPORT_MAX_AGE_MS <= now) {
      await markJobFailed(ctx, job, now, {
        category: "resource_limit",
        message: "Report exceeded its two-hour processing lifetime.",
        retryable: false,
      });
      return { kind: "skip" as const, reason: "Job exceeded its maximum age." };
    }
    const interruptedArtifact = await ctx.db
      .query("operationsReportArtifacts")
      .withIndex(
        "by_job_state_reconciliation_reservation",
        (q) =>
          q
            .eq("jobId", job._id)
            .eq("state", "reserved")
            .eq("reconciliationComplete", false),
      )
      .first();
    if (interruptedArtifact) {
      const reconcileDelayMs = Math.max(
        0,
        interruptedArtifact.reservationExpiresAt - now,
      );
      await ctx.scheduler.runAfter(
        reconcileDelayMs,
        internal.operations.reports.cleanup.reconcileOrphanReservations,
        {},
      );
      const scheduledFunctionId = await scheduleWorker(
        ctx,
        job._id,
        reconcileDelayMs + 2_000,
      );
      await ctx.db.patch(job._id, { scheduledFunctionId, queuedAt: now });
      return {
        kind: "skip" as const,
        reason: "An interrupted artifact upload is being reconciled.",
      };
    }
    if (!(await ownerCanRunReport(ctx, job))) {
      await markJobCanceledForRevocation(ctx, job, now);
      return { kind: "skip" as const, reason: "Owner access was revoked." };
    }
    const leaseGeneration = job.leaseGeneration + 1;
    const leaseExpiresAt = now + REPORT_LEASE_MS;
    const watchdogId = await ctx.scheduler.runAt(
      leaseExpiresAt,
      internal.operations.reports.recovery.recoverJob,
      { jobId: job._id, leaseGeneration },
    );
    const status =
      job.phase === "rendering"
        ? ("rendering" as const)
        : ("running" as const);
    await ctx.db.patch(job._id, {
      status,
      phase: job.phase === "queued" ? "reading" : job.phase,
      startedAt: job.startedAt ?? now,
      leaseGeneration,
      leaseOwner: workerId,
      leaseExpiresAt,
      scheduledFunctionId: watchdogId,
    });
    console.log("[Operations:Reports] claimed", {
      jobId: job._id,
      leaseGeneration,
      phase: job.phase,
    });
    return {
      kind: "claimed" as const,
      leaseGeneration,
      checkpointSequence: job.checkpointSequence,
      status,
    };
  },
});

export const heartbeatLease = internalMutation({
  args: {
    jobId: v.id("operationsReportJobs"),
    workerId: v.string(),
    leaseGeneration: v.number(),
  },
  returns: v.object({ renewed: v.boolean(), leaseExpiresAt: v.optional(v.number()) }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    const now = Date.now();
    if (!job || !hasActiveLease(job, { ...args, now })) {
      return { renewed: false };
    }
    if (!(await ownerCanRunReport(ctx, job))) {
      await markJobCanceledForRevocation(ctx, job, now);
      return { renewed: false };
    }
    const leaseExpiresAt = now + REPORT_LEASE_MS;
    const watchdogId = await ctx.scheduler.runAt(
      leaseExpiresAt,
      internal.operations.reports.recovery.recoverJob,
      { jobId: job._id, leaseGeneration: job.leaseGeneration },
    );
    await ctx.db.patch(job._id, {
      leaseExpiresAt,
      scheduledFunctionId: watchdogId,
    });
    return { renewed: true, leaseExpiresAt };
  },
});

export const commitCheckpoint = internalMutation({
  args: {
    jobId: v.id("operationsReportJobs"),
    workerId: v.string(),
    leaseGeneration: v.number(),
    expectedSequence: v.number(),
    commitKey: v.string(),
    sourceKey: v.string(),
    cursor: v.optional(v.string()),
    splitCursor: v.optional(v.string()),
    completed: v.boolean(),
    rowsProcessed: v.number(),
    contributions: v.array(reportContributionValidator),
    scheduleNext: v.boolean(),
  },
  returns: commitResultValidator,
  handler: async (ctx, args) => {
    assertNonNegativeInteger(args.rowsProcessed, "Rows processed");
    const commitKey = assertBoundedIdentifier(args.commitKey, "Commit key");
    const sourceKey = assertBoundedIdentifier(args.sourceKey, "Source key");
    const job = await ctx.db.get(args.jobId);
    const now = Date.now();
    if (!job || !hasActiveLease(job, { ...args, now })) {
      return staleCommit(job, "Worker does not hold the active lease.");
    }
    const checkpoint = await getJobCheckpoint(ctx, job._id, sourceKey);
    if (job.checkpointSequence !== args.expectedSequence) {
      if (checkpoint?.lastCommitKey === commitKey) {
        return {
          kind: "already_committed" as const,
          sequence: job.checkpointSequence,
        };
      }
      return staleCommit(job, "Checkpoint sequence changed.");
    }
    await applyReportContributions(ctx, job, args.contributions, now);
    const sequence = job.checkpointSequence + 1;
    const checkpointPatch = {
      cursor: args.cursor,
      splitCursor: args.splitCursor,
      sequence,
      completed: args.completed,
      rowsProcessed: (checkpoint?.rowsProcessed ?? 0) + args.rowsProcessed,
      lastCommitKey: commitKey,
      updatedAt: now,
    };
    if (checkpoint) {
      await ctx.db.patch(checkpoint._id, checkpointPatch);
    } else {
      await ctx.db.insert("operationsReportCheckpoints", {
        tenantId: job.tenantId,
        jobId: job._id,
        sourceKey,
        ...checkpointPatch,
      });
    }
    const scheduledFunctionId = args.scheduleNext
      ? await scheduleWorker(ctx, job._id)
      : undefined;
    await ctx.db.patch(job._id, {
      checkpointSequence: sequence,
      rowsProcessed: job.rowsProcessed + args.rowsProcessed,
      pagesProcessed: job.pagesProcessed + 1,
      status: args.scheduleNext ? "queued" : job.status,
      leaseOwner: args.scheduleNext ? undefined : job.leaseOwner,
      leaseExpiresAt: args.scheduleNext ? undefined : job.leaseExpiresAt,
      scheduledFunctionId: args.scheduleNext
        ? scheduledFunctionId
        : job.scheduledFunctionId,
    });
    return { kind: "committed" as const, sequence };
  },
});

export const commitResultRows = internalMutation({
  args: {
    jobId: v.id("operationsReportJobs"),
    workerId: v.string(),
    leaseGeneration: v.number(),
    expectedSequence: v.number(),
    commitKey: v.string(),
    sourceKey: v.string(),
    cursor: v.optional(v.string()),
    rows: v.array(reportResultWriteValidator),
    contributions: v.optional(v.array(reportContributionValidator)),
    completed: v.boolean(),
    renderPosition: v.optional(v.number()),
    scheduleNext: v.boolean(),
  },
  returns: commitResultValidator,
  handler: async (ctx, args) => {
    assertBatchSize(args.rows, "Finalized result batch");
    assertBatchSize(args.contributions ?? [], "Finalizer contribution batch");
    const commitKey = assertBoundedIdentifier(args.commitKey, "Commit key");
    const sourceKey = assertBoundedIdentifier(args.sourceKey, "Source key");
    const job = await ctx.db.get(args.jobId);
    const now = Date.now();
    if (!job || !hasActiveLease(job, { ...args, now })) {
      return staleCommit(job, "Worker does not hold the active lease.");
    }
    const checkpoint = await getJobCheckpoint(ctx, job._id, sourceKey);
    if (job.checkpointSequence !== args.expectedSequence) {
      if (checkpoint?.lastCommitKey === commitKey) {
        return {
          kind: "already_committed" as const,
          sequence: job.checkpointSequence,
        };
      }
      return staleCommit(job, "Checkpoint sequence changed.");
    }
    await applyReportContributions(ctx, job, args.contributions ?? [], now);
    await applyFinalizedRows(ctx, job, args.rows, now);
    const sequence = job.checkpointSequence + 1;
    const checkpointPatch = {
      cursor: args.cursor,
      sequence,
      completed: args.completed,
      rowsProcessed: (checkpoint?.rowsProcessed ?? 0) + args.rows.length,
      renderPosition: args.renderPosition,
      lastCommitKey: commitKey,
      updatedAt: now,
    };
    if (checkpoint) {
      await ctx.db.patch(checkpoint._id, checkpointPatch);
    } else {
      await ctx.db.insert("operationsReportCheckpoints", {
        tenantId: job.tenantId,
        jobId: job._id,
        sourceKey,
        ...checkpointPatch,
      });
    }
    const scheduledFunctionId = args.scheduleNext
      ? await scheduleWorker(ctx, job._id)
      : undefined;
    await ctx.db.patch(job._id, {
      checkpointSequence: sequence,
      status: args.scheduleNext ? "queued" : job.status,
      phase: "reducing",
      leaseOwner: args.scheduleNext ? undefined : job.leaseOwner,
      leaseExpiresAt: args.scheduleNext ? undefined : job.leaseExpiresAt,
      scheduledFunctionId: args.scheduleNext
        ? scheduledFunctionId
        : job.scheduledFunctionId,
    });
    return { kind: "committed" as const, sequence };
  },
});

export const beginRendering = internalMutation({
  args: fencedTransitionArgs(),
  returns: commitResultValidator,
  handler: async (ctx, args) =>
    await transitionUnderLease(ctx, args, {
      status: "rendering",
      phase: "rendering",
    }),
});

export const reserveArtifact = internalMutation({
  args: {
    ...fencedTransitionArgs(),
    partNumber: v.number(),
    filename: v.string(),
    mimeType: v.string(),
    expectedSha256: v.string(),
    expectedByteSize: v.number(),
    rowCount: v.number(),
    ownershipToken: v.string(),
  },
  returns: v.union(
    v.object({
      kind: v.literal("reserved"),
      artifactId: v.id("operationsReportArtifacts"),
      ownershipContentType: v.string(),
      sequence: v.number(),
    }),
    v.object({
      kind: v.literal("already_reserved"),
      artifactId: v.id("operationsReportArtifacts"),
      ownershipContentType: v.string(),
      sequence: v.number(),
    }),
    v.object({ kind: v.literal("stale"), sequence: v.number(), reason: v.string() }),
  ),
  handler: async (ctx, args) => {
    assertNonNegativeInteger(args.partNumber, "Artifact part number");
    assertNonNegativeInteger(args.expectedByteSize, "Expected byte size");
    if (args.expectedByteSize > REPORT_MAX_ARTIFACT_BYTES) {
      throw new Error("Artifact exceeds the 16 MiB part limit.");
    }
    assertNonNegativeInteger(args.rowCount, "Artifact row count");
    const filename = assertBoundedIdentifier(args.filename, "Artifact filename");
    const mimeType = assertMimeType(args.mimeType);
    assertExpectedSha256(args.expectedSha256);
    const ownershipToken = assertOwnershipToken(args.ownershipToken);
    const job = await ctx.db.get(args.jobId);
    const now = Date.now();
    if (!job || !hasActiveLease(job, { ...args, now })) {
      return staleCommit(job, "Worker does not hold the active lease.");
    }
    const existing = await ctx.db
      .query("operationsReportArtifacts")
      .withIndex("by_jobId_and_partNumber", (q) =>
        q.eq("jobId", job._id).eq("partNumber", args.partNumber),
      )
      .unique();
    if (existing) {
      if (
        existing.ownershipToken !== ownershipToken ||
        existing.expectedSha256 !== args.expectedSha256 ||
        existing.expectedByteSize !== args.expectedByteSize
      ) {
        throw new Error("Artifact part was reserved with different content.");
      }
      // A replay may start another upload, so reopen and extend its ownership scan.
      await ctx.db.patch(existing._id, {
        reservationExpiresAt: now + REPORT_UPLOAD_SETTLE_MS,
        reconciliationComplete: false,
        reconciliationCursor: undefined,
        updatedAt: now,
      });
      return {
        kind: "already_reserved" as const,
        artifactId: existing._id,
        ownershipContentType: existing.ownershipContentType,
        sequence: job.checkpointSequence,
      };
    }
    const tokenOwner = await ctx.db
      .query("operationsReportArtifacts")
      .withIndex("by_ownershipToken", (q) =>
        q.eq("ownershipToken", ownershipToken),
      )
      .first();
    if (tokenOwner) {
      throw new Error("Artifact ownership token is already in use.");
    }
    if (job.checkpointSequence !== args.expectedSequence) {
      return staleCommit(job, "Checkpoint sequence changed.");
    }
    const ownershipContentType = `${mimeType}; report-token=${ownershipToken}`;
    const artifactId = await ctx.db.insert("operationsReportArtifacts", {
      tenantId: job.tenantId,
      jobId: job._id,
      partNumber: args.partNumber,
      filename,
      mimeType,
      ownershipContentType,
      state: "reserved",
      expectedSha256: args.expectedSha256,
      expectedByteSize: args.expectedByteSize,
      rowCount: args.rowCount,
      ownershipToken,
      reservedAt: now,
      reservationExpiresAt: now + REPORT_UPLOAD_SETTLE_MS,
      reconciliationComplete: false,
      deleteAttempts: 0,
      updatedAt: now,
    });
    const sequence = job.checkpointSequence + 1;
    await recordLifecycleCommit(ctx, job, args.commitKey, sequence, now);
    await ctx.db.patch(job._id, { checkpointSequence: sequence });
    return {
      kind: "reserved" as const,
      artifactId,
      ownershipContentType,
      sequence,
    };
  },
});

export const attachArtifact = internalMutation({
  args: {
    ...fencedTransitionArgs(),
    artifactId: v.id("operationsReportArtifacts"),
    storageId: v.id("_storage"),
  },
  returns: commitResultValidator,
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    const now = Date.now();
    if (!job || !hasActiveLease(job, { ...args, now })) {
      return staleCommit(job, "Worker does not hold the active lease.");
    }
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.jobId !== job._id || artifact.tenantId !== job.tenantId) {
      throw new Error("Artifact reservation not found.");
    }
    if (artifact.state === "attached" && artifact.storageId === args.storageId) {
      return {
        kind: "already_committed" as const,
        sequence: job.checkpointSequence,
      };
    }
    if (artifact.state === "attached") {
      throw new Error("Artifact reservation is already attached.");
    }
    if (job.checkpointSequence !== args.expectedSequence) {
      return staleCommit(job, "Checkpoint sequence changed.");
    }
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (
      !metadata ||
      metadata.sha256 !== artifact.expectedSha256 ||
      metadata.size !== artifact.expectedByteSize ||
      metadata.contentType !== artifact.ownershipContentType
    ) {
      throw new Error("Stored artifact does not match its reservation.");
    }
    const sequence = job.checkpointSequence + 1;
    await ctx.db.patch(artifact._id, {
      state: "attached",
      storageId: args.storageId,
      byteSize: metadata.size,
      attachedAt: now,
      // Keep ownership discoverable until every possible upload has settled.
      reconciliationComplete: false,
      reconciliationCursor: undefined,
      updatedAt: now,
    });
    await recordLifecycleCommit(ctx, job, args.commitKey, sequence, now);
    await ctx.db.patch(job._id, {
      checkpointSequence: sequence,
      artifactCount: job.artifactCount + 1,
    });
    return { kind: "committed" as const, sequence };
  },
});

export const completeJob = internalMutation({
  args: {
    ...fencedTransitionArgs(),
    expectedArtifactCount: v.number(),
  },
  returns: commitResultValidator,
  handler: async (ctx, args) => {
    assertNonNegativeInteger(args.expectedArtifactCount, "Expected artifact count");
    const job = await ctx.db.get(args.jobId);
    const now = Date.now();
    if (job?.status === "ready") {
      return {
        kind: "already_committed" as const,
        sequence: job.checkpointSequence,
      };
    }
    if (!job || !hasActiveLease(job, { ...args, now })) {
      return staleCommit(job, "Worker does not hold the active lease.");
    }
    if (!(await ownerCanRunReport(ctx, job))) {
      await markJobCanceledForRevocation(ctx, job, now);
      return staleCommit(job, "Owner access was revoked.");
    }
    if (job.checkpointSequence !== args.expectedSequence) {
      return staleCommit(job, "Checkpoint sequence changed.");
    }
    if (
      job.artifactCount !== args.expectedArtifactCount ||
      (job.purpose === "dashboard" && args.expectedArtifactCount !== 0) ||
      (job.purpose === "export" && args.expectedArtifactCount < 1)
    ) {
      throw new Error("Artifact manifest is incomplete.");
    }
    const sequence = job.checkpointSequence + 1;
    const expiresAt = now + REPORT_READY_LIFETIME_MS;
    await recordLifecycleCommit(ctx, job, args.commitKey, sequence, now);
    await ctx.db.patch(job._id, {
      checkpointSequence: sequence,
      status: "ready",
      phase: "ready",
      completedAt: now,
      expiresAt,
      purgeAt: now + REPORT_JOB_METADATA_RETENTION_MS,
      leaseGeneration: job.leaseGeneration + 1,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      scheduledFunctionId: undefined,
    });
    console.log("[Operations:Reports] ready", {
      jobId: job._id,
      purpose: job.purpose,
      reportKind: job.reportKind,
      rowsProcessed: job.rowsProcessed,
      pagesProcessed: job.pagesProcessed,
      artifactCount: job.artifactCount,
    });
    return { kind: "committed" as const, sequence };
  },
});

export const failJob = internalMutation({
  args: {
    jobId: v.id("operationsReportJobs"),
    workerId: v.string(),
    leaseGeneration: v.number(),
    category: v.string(),
    message: v.string(),
    retryable: v.boolean(),
  },
  returns: v.object({ failed: v.boolean() }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      !job ||
      (job.status !== "running" && job.status !== "rendering") ||
      job.leaseOwner !== args.workerId ||
      job.leaseGeneration !== args.leaseGeneration
    ) {
      return { failed: false };
    }
    await markJobFailed(ctx, job, Date.now(), {
      category: sanitizeFailureText(args.category, 80),
      message: sanitizeFailureText(args.message, 500),
      retryable: args.retryable,
    });
    return { failed: true };
  },
});

async function requestReport(
  ctx: MutationCtx,
  args: {
    purpose: ReportPurpose;
    reportKind: ReportKind;
    format?: ReportFormat;
    range: ReportRangeInput;
    sourceFilter: ReportSourceFilter;
    requestToken: string;
  },
) {
  const auth = await requireTenantUser(ctx, [...ADMIN_ROLES]);
  const requestToken = assertBoundedIdentifier(args.requestToken, "Request token");
  assertValidSourceFilter(args.reportKind, args.sourceFilter);
  if (args.format) {
    assertValidReportFormat(args.reportKind, args.format);
  }
  const now = Date.now();
  const range = normalizeReportRange({
    reportKind: args.reportKind,
    input: args.range,
    now,
  });
  const requestKey = buildReportRequestKey({
    purpose: args.purpose,
    reportKind: args.reportKind,
    format: args.format,
    range,
    sourceFilter: args.sourceFilter,
  });

  const tokenMatch = await ctx.db
    .query("operationsReportJobs")
    .withIndex("by_tenantId_and_requestedByUserId_and_requestToken", (q) =>
      q
        .eq("tenantId", auth.tenantId)
        .eq("requestedByUserId", auth.userId)
        .eq("requestToken", requestToken),
    )
    .unique();
  if (tokenMatch) {
    if (tokenMatch.requestKey !== requestKey) {
      throw new Error("Request token was already used for a different report.");
    }
    return { jobId: tokenMatch._id, requestKey: tokenMatch.requestKey };
  }

  const equivalent = await findActiveEquivalent(
    ctx,
    auth.tenantId,
    auth.userId,
    requestKey,
  );
  if (equivalent) {
    return { jobId: equivalent._id, requestKey: equivalent.requestKey };
  }

  const [userActive, tenantActive] = await Promise.all([
    listActiveJobsForUser(ctx, auth.tenantId, auth.userId, args.purpose, 2),
    listActiveJobsForTenant(ctx, auth.tenantId, 3),
  ]);
  if (userActive.length >= 1) {
    throw new Error(`You already have an active ${args.purpose} report.`);
  }
  if (tenantActive.length >= 2) {
    throw new Error("This workspace already has two active reports.");
  }

  const jobId = await ctx.db.insert("operationsReportJobs", {
    tenantId: auth.tenantId,
    requestedByUserId: auth.userId,
    purpose: args.purpose,
    reportKind: args.reportKind,
    format: args.format,
    range,
    sourceFilter: args.sourceFilter,
    requestToken,
    requestKey,
    definitionVersion: REPORT_DEFINITION_VERSION,
    status: "queued",
    phase: "queued",
    rowsProcessed: 0,
    pagesProcessed: 0,
    artifactCount: 0,
    checkpointSequence: 0,
    leaseGeneration: 0,
    retryCount: 0,
    cleanupPending: false,
    queuedAt: now,
    createdAt: now,
  });
  const scheduledFunctionId = await scheduleWorker(ctx, jobId);
  await ctx.db.patch(jobId, { scheduledFunctionId });
  console.log("[Operations:Reports] queued", {
    jobId,
    purpose: args.purpose,
    reportKind: args.reportKind,
    format: args.format ?? null,
    dayCount: range.dayCount,
  });
  return { jobId, requestKey };
}

async function requireOwnedJob(
  ctx: QueryCtx | MutationCtx,
  jobId: Id<"operationsReportJobs">,
) {
  const auth = await requireTenantUser(ctx, [...ADMIN_ROLES]);
  const job = await ctx.db.get(jobId);
  if (
    !job ||
    job.tenantId !== auth.tenantId ||
    job.requestedByUserId !== auth.userId
  ) {
    throw new Error("Report job not found.");
  }
  return job;
}

function assertReadyDashboard(job: Doc<"operationsReportJobs">) {
  if (job.definitionVersion !== REPORT_DEFINITION_VERSION) {
    throw new Error("This report uses an older definition. Regenerate the report.");
  }
  if (job.purpose !== "dashboard" || job.status !== "ready") {
    throw new Error("Dashboard report is not ready.");
  }
}

async function findActiveEquivalent(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  userId: Id<"users">,
  requestKey: string,
) {
  for (const status of activeReportStatuses) {
    const job = await ctx.db
      .query("operationsReportJobs")
      .withIndex("by_tenantId_and_requestedByUserId_and_requestKey_and_status", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("requestedByUserId", userId)
          .eq("requestKey", requestKey)
          .eq("status", status),
      )
      .first();
    if (job) return job;
  }
  return null;
}

async function listActiveJobsForUser(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  userId: Id<"users">,
  purpose: ReportPurpose,
  limit: number,
) {
  const jobs: Doc<"operationsReportJobs">[] = [];
  for (const status of activeReportStatuses) {
    const matches = await ctx.db
      .query("operationsReportJobs")
      .withIndex("by_tenantId_and_requestedByUserId_and_purpose_and_status", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("requestedByUserId", userId)
          .eq("purpose", purpose)
          .eq("status", status),
      )
      .take(limit - jobs.length);
    jobs.push(...matches);
    if (jobs.length >= limit) break;
  }
  return jobs;
}

async function listActiveJobsForTenant(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  limit: number,
) {
  const jobs: Doc<"operationsReportJobs">[] = [];
  for (const status of activeReportStatuses) {
    const matches = await ctx.db
      .query("operationsReportJobs")
      .withIndex("by_tenantId_and_status", (q) =>
        q.eq("tenantId", tenantId).eq("status", status),
      )
      .take(limit - jobs.length);
    jobs.push(...matches);
    if (jobs.length >= limit) break;
  }
  return jobs;
}

async function scheduleWorker(
  ctx: MutationCtx,
  jobId: Id<"operationsReportJobs">,
  delayMs = 0,
) {
  return await ctx.scheduler.runAfter(
    delayMs,
    internal.operations.reports.worker.run,
    { jobId },
  );
}

function fencedTransitionArgs() {
  return {
    jobId: v.id("operationsReportJobs"),
    workerId: v.string(),
    leaseGeneration: v.number(),
    expectedSequence: v.number(),
    commitKey: v.string(),
  };
}

async function transitionUnderLease(
  ctx: MutationCtx,
  args: {
    jobId: Id<"operationsReportJobs">;
    workerId: string;
    leaseGeneration: number;
    expectedSequence: number;
    commitKey: string;
  },
  patch: { status: "rendering"; phase: "rendering" },
) {
  const job = await ctx.db.get(args.jobId);
  const now = Date.now();
  if (!job || !hasActiveLease(job, { ...args, now })) {
    return staleCommit(job, "Worker does not hold the active lease.");
  }
  const lifecycle = await getJobCheckpoint(ctx, job._id, "__lifecycle__");
  if (job.checkpointSequence !== args.expectedSequence) {
    if (lifecycle?.lastCommitKey === args.commitKey) {
      return {
        kind: "already_committed" as const,
        sequence: job.checkpointSequence,
      };
    }
    return staleCommit(job, "Checkpoint sequence changed.");
  }
  const sequence = job.checkpointSequence + 1;
  await recordLifecycleCommit(ctx, job, args.commitKey, sequence, now);
  await ctx.db.patch(job._id, { ...patch, checkpointSequence: sequence });
  return { kind: "committed" as const, sequence };
}

async function recordLifecycleCommit(
  ctx: MutationCtx,
  job: Doc<"operationsReportJobs">,
  commitKey: string,
  sequence: number,
  now: number,
) {
  const safeCommitKey = assertBoundedIdentifier(commitKey, "Commit key");
  const checkpoint = await getJobCheckpoint(ctx, job._id, "__lifecycle__");
  const patch = {
    sequence,
    completed: false,
    rowsProcessed: checkpoint?.rowsProcessed ?? 0,
    lastCommitKey: safeCommitKey,
    updatedAt: now,
  };
  if (checkpoint) {
    await ctx.db.patch(checkpoint._id, patch);
  } else {
    await ctx.db.insert("operationsReportCheckpoints", {
      tenantId: job.tenantId,
      jobId: job._id,
      sourceKey: "__lifecycle__",
      ...patch,
    });
  }
}

function staleCommit(job: Doc<"operationsReportJobs"> | null, reason: string) {
  return {
    kind: "stale" as const,
    sequence: job?.checkpointSequence ?? -1,
    reason,
  };
}

async function markJobFailed(
  ctx: MutationCtx,
  job: Doc<"operationsReportJobs">,
  now: number,
  failure: { category: string; message: string; retryable: boolean },
) {
  await ctx.db.patch(job._id, {
    status: "failed",
    phase: "cleanup",
    failure,
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
  console.error("[Operations:Reports] failed", {
    jobId: job._id,
    category: failure.category,
    retryable: failure.retryable,
  });
}

async function markJobCanceledForRevocation(
  ctx: MutationCtx,
  job: Doc<"operationsReportJobs">,
  now: number,
) {
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

function sanitizeFailureText(value: string, maxLength: number) {
  const oneLine = value.replace(/[\r\n\t]+/g, " ").trim();
  return (oneLine || "Report processing failed.").slice(0, maxLength);
}

function toPublicJob(job: Doc<"operationsReportJobs">) {
  const definitionOutdated = job.definitionVersion !== REPORT_DEFINITION_VERSION;
  return {
    jobId: job._id,
    purpose: job.purpose,
    reportKind: job.reportKind,
    format: job.format,
    range: job.range,
    sourceFilter: job.sourceFilter,
    requestKey: job.requestKey,
    definitionVersion: job.definitionVersion,
    status: definitionOutdated ? ("failed" as const) : job.status,
    phase: job.phase,
    rowsProcessed: job.rowsProcessed,
    pagesProcessed: job.pagesProcessed,
    artifactCount: job.artifactCount,
    retryCount: job.retryCount,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    expiresAt: job.expiresAt,
    failure: definitionOutdated
      ? {
          category: "definition_version",
          message: "This report was created with an older definition. Regenerate the report.",
          retryable: false,
        }
      : job.failure,
  };
}

function toInternalJob(job: Doc<"operationsReportJobs">) {
  return {
    jobId: job._id,
    tenantId: job.tenantId,
    requestedByUserId: job.requestedByUserId,
    purpose: job.purpose,
    reportKind: job.reportKind,
    format: job.format,
    range: job.range,
    sourceFilter: job.sourceFilter,
    definitionVersion: job.definitionVersion,
    status: job.status,
    phase: job.phase,
    rowsProcessed: job.rowsProcessed,
    pagesProcessed: job.pagesProcessed,
    artifactCount: job.artifactCount,
    checkpointSequence: job.checkpointSequence,
    leaseGeneration: job.leaseGeneration,
    leaseOwner: job.leaseOwner,
    leaseExpiresAt: job.leaseExpiresAt,
    retryCount: job.retryCount,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
  };
}

function toPublicCheckpoint(checkpoint: Doc<"operationsReportCheckpoints">) {
  return {
    sourceKey: checkpoint.sourceKey,
    cursor: checkpoint.cursor,
    splitCursor: checkpoint.splitCursor,
    sequence: checkpoint.sequence,
    completed: checkpoint.completed,
    rowsProcessed: checkpoint.rowsProcessed,
    renderPosition: checkpoint.renderPosition,
    lastCommitKey: checkpoint.lastCommitKey,
  };
}

function toPublicResultRow(row: Doc<"operationsReportRows">) {
  return {
    rowId: row._id,
    section: row.section,
    rowKey: row.rowKey,
    payload: row.payload,
    groupKey: row.groupKey,
    sortValue: row.sortValue,
  };
}

function summarySection(reportKind: ReportKind) {
  return `${reportKind.replaceAll("-", "_")}_summary`;
}

function clampPublicPagination(options: {
  numItems: number;
  cursor: string | null;
  endCursor?: string | null;
  id?: number;
  maximumRowsRead?: number;
  maximumBytesRead?: number;
}) {
  if (!Number.isFinite(options.numItems) || options.numItems <= 0) {
    throw new Error("Page size must be positive.");
  }
  return {
    ...options,
    numItems: Math.min(Math.floor(options.numItems), REPORT_MAX_PUBLIC_PAGE_SIZE),
    maximumRowsRead: Math.min(
      options.maximumRowsRead ?? REPORT_MAX_PUBLIC_PAGE_SIZE,
      REPORT_MAX_PUBLIC_PAGE_SIZE,
    ),
    maximumBytesRead: Math.min(options.maximumBytesRead ?? 1_048_576, 1_048_576),
  };
}

function assertOwnershipToken(value: string) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new Error("Artifact ownership token is invalid.");
  }
  return value;
}

function assertMimeType(value: string) {
  const mimeType = value.trim().toLowerCase();
  if (
    !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*(?:;[a-z0-9][a-z0-9_-]*=[a-z0-9._+-]+)*$/.test(
      mimeType,
    ) ||
    mimeType.split(";").slice(1).some((parameter) => parameter.startsWith("report-token="))
  ) {
    throw new Error("Artifact MIME type is invalid.");
  }
  return mimeType;
}

function assertExpectedSha256(value: string) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error("Artifact SHA-256 must use the storage metadata base64 format.");
  }
}
