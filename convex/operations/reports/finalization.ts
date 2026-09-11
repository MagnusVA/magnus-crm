import { v } from "convex/values";
import { internalQuery } from "../../_generated/server";
import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { reportContributionValidator, reportResultWriteValidator, type ReportContribution, type ReportResultWrite, type ScalarRecord } from "./contracts";
import { finalizeAggregateRecord } from "./reducers";

async function related(ctx: QueryCtx, jobId: Id<"operationsReportJobs">, section: string, rowKey: unknown) {
  if (typeof rowKey !== "string") return {};
  const row = await ctx.db.query("operationsReportRows").withIndex("by_jobId_and_section_and_rowKey", (q) => q.eq("jobId", jobId).eq("section", section).eq("rowKey", rowKey)).unique();
  return row?.payload ?? {};
}

const summaryDefaults: Record<string, ScalarRecord> = {
  lead_gen_summary: { submissions: 0, uniqueProspects: 0, duplicates: 0, scheduledHours: 0, workersActive: 0 },
  qualifications_summary: { totalQualified: 0, dailyQuota: null, target: null },
  booked_calls_summary: { totalBooked: 0, totalTarget: null },
  sales_calls_summary: { booked: 0, showed: 0, canceled: 0, noShows: 0, paymentSalesCount: 0, cashCollectedMinor: 0 },
};

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
      const dimensionSections: Record<string, string> = {
        lead_gen_worker: "lead_gen_worker_dimension", lead_gen_team: "team_dimension",
        qualification_opener: "slack_user_dimension", booked_closer: "dm_closer_dimension",
        sales_closer: "user_dimension", sales_program: "program_dimension",
      };
      const dimension = dimensionSections[args.section] ? await related(ctx, args.jobId, dimensionSections[args.section], row.rowKey) : {};
      const fields = { ...(summaryDefaults[args.section] ?? {}), ...dimension, ...row.fields };
      let relatedFields: ScalarRecord | undefined;
      if (args.section === "booked_closer") {
        relatedFields = await related(ctx, args.jobId, "booked_closer_schedule", row.rowKey);
        const team = await related(ctx, args.jobId, "team_dimension", fields.teamId);
        fields.teamLabel = team.label ?? "Unassigned";
      }
      if (["lead_gen_worker", "lead_gen_team_worker", "lead_gen_team_source", "lead_gen_team_origin", "lead_gen_daily_summary", "raw_submission"].includes(args.section)) {
        const team = await related(ctx, args.jobId, "team_dimension", fields.teamId);
        fields.teamLabel = team.label ?? "No Team";
      }
      if (args.section === "raw_submission" || args.section === "lead_gen_daily_summary" || args.section === "lead_gen_team_worker") {
        const worker = await related(ctx, args.jobId, "lead_gen_worker_dimension", fields.workerId);
        fields.workerLabel = worker.label ?? fields.workerId ?? "Unknown specialist";
        fields.workerEmail = worker.email ?? "";
        fields.isActive = worker.isActive ?? false;
      }
      if (args.section === "raw_qualification") {
        const qualifier = await related(ctx, args.jobId, "slack_user_dimension", fields.slackUserId);
        fields.qualifierLabel = qualifier.label ?? fields.slackUserId ?? "Unknown qualifier";
      }
      if (args.section === "lead_gen_source") fields.source = row.rowKey;
      const result = finalizeAggregateRecord({ section: args.section, rowKey: row.rowKey, fields, range: job.range, ...(relatedFields ? { relatedFields } : {}) });
      if (!result) continue;
      if (["lead_gen_team_worker", "lead_gen_team_source", "lead_gen_team_origin"].includes(args.section)) result.groupKey = String(fields.teamId ?? "unassigned");
      if (args.section === "booking_team" && typeof result.payload.target === "number") contributions.push({ section: "booked_calls_summary", rowKey: "main", field: "totalTarget", operation: "sum", value: result.payload.target });
      rows.push(result);
    }
    return { rows, contributions, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});
