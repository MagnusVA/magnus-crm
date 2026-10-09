import { v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import { internalAction } from "../../_generated/server";
import { reportError } from "../../lib/observability/log";
import { REPORT_FINALIZATION_ORDER } from "./catalog";
import { reduceReportSourcePage } from "./reducers";
import { sourcesForReport } from "./sources";
export { sourcesForReport } from "./sources";

const MAX_PAGES_PER_STEP = 20;
const STEP_BUDGET_MS = 40_000;

export const run = internalAction({
  args: { jobId: v.id("operationsReportJobs") },
  returns: v.null(),
  handler: async (ctx, { jobId }): Promise<null> => {
    const workerId = crypto.randomUUID();
    const claim = await ctx.runMutation(internal.operations.reports.jobs.claimJob, { jobId, workerId });
    if (claim.kind !== "claimed") return null;
    const fence = { jobId, workerId, leaseGeneration: claim.leaseGeneration };
    let sequence = claim.checkpointSequence;
    // Kept outside the try so a failure report can describe the job.
    let jobContext: Partial<Pick<Doc<"operationsReportJobs">, "tenantId" | "reportKind" | "purpose" | "phase" | "retryCount">> = {};
    try {
      const job = await ctx.runQuery(internal.operations.reports.jobs.getJobState, { jobId });
      if (!job) return null;
      jobContext = { tenantId: job.tenantId, reportKind: job.reportKind, purpose: job.purpose, phase: job.phase, retryCount: job.retryCount };
      if (job.phase === "rendering") {
        await ctx.runAction(internal.operations.reports.render.run, fence);
        return null;
      }
      const started = Date.now();
      let pages = 0;
      for (const sourceKey of sourcesForReport(job)) {
        let checkpoint: { completed: boolean; cursor?: string } | null = await ctx.runQuery(internal.operations.reports.jobs.getCheckpoint, { jobId, sourceKey });
        if (checkpoint?.completed) continue;
        while (!checkpoint?.completed) {
          // One-shot scans never supply endCursor. Even a byte-limited
          // SplitRequired page is complete through its returned continueCursor.
          // Committing splitCursor instead would replay already counted rows.
          const page = await ctx.runQuery(internal.operations.reports.readers.readReportSourcePage, {
            tenantId: job.tenantId, reportKind: job.reportKind, sourceKey,
            startTimestamp: job.range.startTimestamp, endTimestampExclusive: job.range.endTimestampExclusive,
            startDayKey: job.range.startDayKey, endDayKeyExclusive: job.range.endDayKeyExclusive,
            sourceFilter: job.sourceFilter, teamId: null, workerId: null, cursor: checkpoint?.cursor ?? null,
          });
          const contributions = reduceReportSourcePage({ sourceKey, range: job.range, rows: page.page }).filter((contribution) =>
            !contribution.section.startsWith("raw_") || (job.purpose === "export" && (job.format === "raw_csv" || job.format === "payments_csv")),
          );
          pages += 1;
          const scheduleNext = pages >= MAX_PAGES_PER_STEP || Date.now() - started >= STEP_BUDGET_MS;
          const commit = await ctx.runMutation(internal.operations.reports.jobs.commitCheckpoint, {
            ...fence, expectedSequence: sequence, commitKey: `${sourceKey}:${sequence}`, sourceKey,
            cursor: page.continueCursor, ...(page.splitCursor ? { splitCursor: page.splitCursor } : {}),
            completed: page.isDone, rowsProcessed: page.rowsRead, contributions, scheduleNext,
          });
          if (commit.kind === "stale") return null;
          sequence = commit.sequence;
          if (scheduleNext) return null;
          checkpoint = { cursor: page.continueCursor, completed: page.isDone };
        }
      }
      for (const section of REPORT_FINALIZATION_ORDER[job.reportKind]) {
        if (section.startsWith("raw_") && (job.purpose !== "export" || (job.format !== "raw_csv" && job.format !== "payments_csv"))) continue;
        const sourceKey = `finalize:${section}`;
        let checkpoint: { completed: boolean; cursor?: string } | null = await ctx.runQuery(internal.operations.reports.jobs.getCheckpoint, { jobId, sourceKey });
        if (checkpoint?.completed) continue;
        while (!checkpoint?.completed) {
          const page = await ctx.runQuery(internal.operations.reports.finalization.readFinalizationPage, { jobId, section, cursor: checkpoint?.cursor ?? null });
          pages += 1;
          const scheduleNext = pages >= MAX_PAGES_PER_STEP || Date.now() - started >= STEP_BUDGET_MS;
          const commit = await ctx.runMutation(internal.operations.reports.jobs.commitResultRows, {
            ...fence, expectedSequence: sequence, commitKey: `${sourceKey}:${sequence}`, sourceKey,
            rows: page.rows, contributions: page.contributions, completed: page.isDone, cursor: page.continueCursor, scheduleNext,
          });
          if (commit.kind === "stale") return null;
          sequence = commit.sequence;
          if (scheduleNext) return null;
          checkpoint = { cursor: page.continueCursor, completed: page.isDone };
        }
      }
      if (job.purpose === "dashboard") {
        await ctx.runMutation(internal.operations.reports.jobs.completeJob, { ...fence, expectedSequence: sequence, commitKey: `complete:${sequence}`, expectedArtifactCount: 0 });
      } else {
        const transition = await ctx.runMutation(internal.operations.reports.jobs.beginRendering, { ...fence, expectedSequence: sequence, commitKey: `render:${sequence}` });
        if (transition.kind !== "stale") await ctx.runAction(internal.operations.reports.render.run, fence);
      }
    } catch (error) {
      const failure = { category: "processing_error", retryable: true };
      // The job stores a generic message, so this is the only record of the
      // real error and its stack.
      reportError("reports.job.failed", error, {
        severity: "warning", fingerprint: "reports.job.failed:dashboard",
        jobId, ...jobContext, ...failure, leaseGeneration: claim.leaseGeneration, worker: "dashboard",
      });
      await ctx.runMutation(internal.operations.reports.jobs.failJob, {
        ...fence, ...failure, message: "The report could not be completed. Retry the report or choose a smaller date range.",
      });
    }
    return null;
  },
});
