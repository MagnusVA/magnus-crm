import { v } from "convex/values";
import { internal } from "../../_generated/api";
import { internalAction } from "../../_generated/server";
import { REPORT_FINALIZATION_ORDER, REPORT_SOURCE_ORDER } from "./catalog";
import { reduceReportSourcePage } from "./reducers";
import type { ReportKind, ReportFormat, ReportPurpose } from "./contracts";

const MAX_PAGES_PER_STEP = 20;
const STEP_BUDGET_MS = 40_000;
const CURRENCY_ERROR = "This report contains a non-USD payment. Download Raw Payments CSV to review currencies; monetary dashboards and reports currently support USD only.";

export function sourcesForReport(job: { reportKind: ReportKind; purpose: ReportPurpose; format?: ReportFormat }) {
  const sources = REPORT_SOURCE_ORDER[job.reportKind];
  if (job.purpose === "dashboard" || job.format === "pdf" || job.format === "xlsx") {
    return sources.filter((key) => key !== "lead_gen_submissions" && key !== "sales_calls");
  }
  if (job.format === "summary_csv") return sources.filter((key) => key !== "lead_gen_submissions" && key !== "sales_calls");
  const keep: Record<ReportKind, string[]> = {
    "lead-gen": ["lead_gen_workers", "teams", "lead_gen_submissions"],
    qualifications: ["slack_users", "qualification_events"],
    "booked-calls": ["teams", "dm_closers", "booked_meetings"],
    "sales-calls": ["users", "programs", job.format === "payments_csv" ? "sales_payments" : "sales_calls"],
  };
  return sources.filter((key) => keep[job.reportKind].includes(key));
}

export const run = internalAction({
  args: { jobId: v.id("operationsReportJobs") },
  returns: v.null(),
  handler: async (ctx, { jobId }): Promise<null> => {
    const workerId = crypto.randomUUID();
    const claim = await ctx.runMutation(internal.operations.reports.jobs.claimJob, { jobId, workerId });
    if (claim.kind !== "claimed") return null;
    const fence = { jobId, workerId, leaseGeneration: claim.leaseGeneration };
    let sequence = claim.checkpointSequence;
    try {
      const job = await ctx.runQuery(internal.operations.reports.jobs.getJobState, { jobId });
      if (!job) return null;
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
          if (!(await ctx.runMutation(internal.operations.reports.jobs.heartbeatLease, fence)).renewed) return null;
          // One-shot scans never supply endCursor. Even a byte-limited
          // SplitRequired page is complete through its returned continueCursor.
          // Committing splitCursor instead would replay already counted rows.
          const page = await ctx.runQuery(internal.operations.reports.readers.readReportSourcePage, {
            tenantId: job.tenantId, reportKind: job.reportKind, sourceKey,
            startTimestamp: job.range.startTimestamp, endTimestampExclusive: job.range.endTimestampExclusive,
            startDayKey: job.range.startDayKey, endDayKeyExclusive: job.range.endDayKeyExclusive,
            sourceFilter: job.sourceFilter, teamId: null, workerId: null, cursor: checkpoint?.cursor ?? null,
          });
          if (job.reportKind === "sales-calls" && job.format !== "payments_csv" && page.page.some(row => row.kind === "sales_payment" && row.currency.toLowerCase() !== "usd")) throw new Error(CURRENCY_ERROR);
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
          if (!(await ctx.runMutation(internal.operations.reports.jobs.heartbeatLease, fence)).renewed) return null;
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
      console.error("[Operations:Reports] worker failed", { jobId, message: error instanceof Error ? error.message : String(error) });
      await ctx.runMutation(internal.operations.reports.jobs.failJob, {
        ...fence, category: error instanceof Error && error.message === CURRENCY_ERROR ? "unsupported_currency" : "processing_error", message: error instanceof Error && error.message === CURRENCY_ERROR ? CURRENCY_ERROR : "The report could not be completed. Retry the report or choose a smaller date range.", retryable: !(error instanceof Error && error.message === CURRENCY_ERROR),
      });
    }
    return null;
  },
});
