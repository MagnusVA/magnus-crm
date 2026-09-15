import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

// Progress never writes this record. Only admission and terminal transitions do.
export async function releaseAdmission(
  ctx: MutationCtx,
  job: Doc<"operationsReportJobs">,
) {
  const admission = await ctx.db
    .query("operationsReportAdmission")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", job.tenantId))
    .unique();
  if (admission?.slots.some((slot) => slot.jobId === job._id)) {
    await ctx.db.patch(admission._id, {
      slots: admission.slots.filter((slot) => slot.jobId !== job._id),
    });
  }
}

export async function scheduleWorker(
  ctx: MutationCtx,
  jobId: Id<"operationsReportJobs">,
  delayMs = 0,
): Promise<Id<"_scheduled_functions">> {
  const job = await ctx.db.get(jobId);
  return await ctx.scheduler.runAfter(
    delayMs,
    job?.executionVersion === 2 && job.purpose === "export"
      ? internal.operations.reports.exportWorker.run
      : internal.operations.reports.worker.run,
    { jobId },
  );
}
