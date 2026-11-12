import { anyApi, type ApiFromModules } from "convex/server";
import type * as judgeModule from "./judge";
import type * as regressionModule from "./regression";
import type * as driftModule from "./drift";
import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { internal } from "../../_generated/api";

const evalInternal = (
  anyApi as unknown as ApiFromModules<{
    "callInsights/eval/judge": typeof judgeModule;
    "callInsights/eval/regression": typeof regressionModule;
    "callInsights/eval/drift": typeof driftModule;
  }>
).callInsights.eval;

/** Eval items report completion through jobs.itemFinished, like serving reads. */
export const startItem = internalMutation({
  args: {
    jobId: v.id("callInsightJobs"),
    jobItemId: v.id("callInsightJobItems"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("callInsightJobs", args.jobId);
    const item = await ctx.db.get("callInsightJobItems", args.jobItemId);
    if (!job || !item || item.jobId !== job._id || item.status !== "running")
      return null;
    if (job.kind === "eval_regression") {
      await ctx.scheduler.runAfter(0, evalInternal.regression.reextract, args);
    } else if (job.kind === "eval_judge") {
      const cases = await ctx.db
        .query("callInsightEvalCases")
        .withIndex("by_recordingId_and_campaign", (q) =>
          q
            .eq("recordingId", item.recordingId)
            .eq("campaign", job.campaign ?? ""),
        )
        .take(2);
      const row = cases.find((c) => c.tenantId === job.tenantId);
      if (row)
        await ctx.scheduler.runAfter(0, evalInternal.judge.judgeCase, {
          ...args,
          caseId: row._id,
        });
      else
        await ctx.scheduler.runAfter(
          0,
          internal.callInsights.jobs.itemFinished,
          { ...args, outcome: "skipped" },
        );
    }
    return null;
  },
});
export const jobFinished = internalMutation({
  args: { jobId: v.id("callInsightJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("callInsightJobs", args.jobId);
    if (job?.kind === "eval_regression" && job.status === "done")
      await ctx.scheduler.runAfter(
        0,
        evalInternal.regression.buildReport,
        args,
      );
    return null;
  },
});
