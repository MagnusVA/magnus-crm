import { v } from "convex/values";
import { internalQuery } from "../../_generated/server";
import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { reportContributionValidator, reportResultWriteValidator, type ReportContribution, type ReportResultWrite } from "./contracts";
import { finalizeReportRow, summaryDefaults } from "./finalizeRow";

async function related(ctx: QueryCtx, jobId: Id<"operationsReportJobs">, section: string, rowKey: unknown) {
  if (typeof rowKey !== "string") return {};
  const row = await ctx.db.query("operationsReportRows").withIndex("by_jobId_and_section_and_rowKey", (q) => q.eq("jobId", jobId).eq("section", section).eq("rowKey", rowKey)).unique();
  return row?.payload ?? {};
}

export const readFinalizationPage = internalQuery({
  args: { jobId: v.id("operationsReportJobs"), section: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ rows: v.array(reportResultWriteValidator), contributions: v.array(reportContributionValidator), continueCursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Report job not found.");
    // Four primary rows leave room for up to three related records per row.
    const page = await ctx.db.query("operationsReportRows")
      .withIndex("by_jobId_and_section_and_rowType_and_rowKey", (q) => q.eq("jobId", args.jobId).eq("section", args.section).eq("rowType", "staging"))
      .paginate({ cursor: args.cursor, numItems: 4, maximumRowsRead: 4, maximumBytesRead: 256 * 1024 });
    const rows: ReportResultWrite[] = [];
    const contributions: ReportContribution[] = [];
    const inputs = page.page.map((row) => ({ rowKey: row.rowKey, fields: row.payload }));
    if (page.isDone && inputs.length === 0 && args.cursor === null && summaryDefaults[args.section]) inputs.push({ rowKey: "main", fields: {} });
    for (const row of inputs) {
      const result = await finalizeReportRow(args.section, row, job.range, (section, key) => related(ctx, args.jobId, section, key));
      if (!result) continue;
      if (args.section === "booking_team" && typeof result.payload.target === "number") contributions.push({ section: "booked_calls_summary", rowKey: "main", field: "totalTarget", operation: "sum", value: result.payload.target });
      rows.push(result);
    }
    return { rows, contributions, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});
