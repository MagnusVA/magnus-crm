import { v } from "convex/values";
import { internalQuery } from "../../_generated/server";
import { scalarRecordValidator } from "./contracts";

// One team per transaction: at most nine compact aggregate records are read.
export const readTeam = internalQuery({
  args: { jobId: v.id("operationsReportJobs"), teamKey: v.string() },
  returns: v.object({ summary: scalarRecordValidator, workers: v.array(scalarRecordValidator), origins: v.array(scalarRecordValidator), sources: v.array(scalarRecordValidator) }),
  handler: async (ctx, { jobId, teamKey }) => {
    const summary = await ctx.db.query("operationsReportRows").withIndex("by_jobId_and_section_and_rowKey", q => q.eq("jobId", jobId).eq("section", "lead_gen_team").eq("rowKey", teamKey)).unique();
    const top = async (section: string, count: number) => (await ctx.db.query("operationsReportRows").withIndex("by_jobId_and_section_and_groupKey_and_sortValue", q => q.eq("jobId", jobId).eq("section", section).eq("groupKey", teamKey)).order("desc").take(count)).map(row => row.payload);
    return { summary: summary?.payload ?? {}, workers: await top("lead_gen_team_worker", 3), origins: await top("lead_gen_team_origin", 3), sources: await top("lead_gen_team_source", 2) };
  },
});
