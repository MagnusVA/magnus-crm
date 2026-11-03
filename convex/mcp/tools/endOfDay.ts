import { v } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { internalMutation, internalQuery } from "../../_generated/server";
import { endDayCore, getDaySummaryCore } from "../../closer/endOfDay";
import { endOfDayGapValidator, endOfDayNumbersValidator } from "../../closer/endOfDaySchema";
import { mcpCallerValidator, requireMcpUser } from "../guard";
import { formatLocal } from "../time";

/**
 * `magnus_day_summary` and `magnus_end_day` (docs/plans/closer-assistant.md
 * §6.6). Magnus counts every number; the agent writes only the lines about
 * each person and the closer's note.
 */
const windowValidator = v.object({
  from: v.string(),
  to: v.string(),
  previousDayUnclosed: v.boolean(),
});

export const summary = internalQuery({
  args: { caller: mcpCallerValidator },
  returns: v.object({
    timeZone: v.string(),
    window: windowValidator,
    numbers: endOfDayNumbersValidator,
    gaps: v.array(endOfDayGapValidator),
    slackChannel: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { caller }) => {
    const me = await requireMcpUser(ctx, caller, ["closer"]);
    const day = await getDaySummaryCore(ctx, me, { now: Date.now() });
    return {
      timeZone: day.timeZone,
      window: {
        from: formatLocal(day.periodStart, day.timeZone),
        to: formatLocal(day.periodEnd, day.timeZone),
        previousDayUnclosed: day.previousDayUnclosed,
      },
      numbers: day.numbers,
      gaps: day.gaps,
      slackChannel: day.slackChannelName ? `#${day.slackChannelName}` : null,
    };
  },
});

function slackLine(report: Doc<"endOfDayReports">) {
  switch (report.slackStatus) {
    case "not_configured":
      return "Saved in Magnus. No end-of-day channel is set, so nothing was posted.";
    case "posted":
      return `Posted to #${report.slackChannelName ?? "the end-of-day channel"}.`;
    case "failed":
      return `Saved in Magnus, but Slack refused the post${report.slackError ? ` (${report.slackError})` : ""}. An admin can fix the channel, then retry from Magnus.`;
    default:
      return `Saved in Magnus. Posting to #${report.slackChannelName ?? "the end-of-day channel"}.`;
  }
}

export const endDay = internalMutation({
  args: {
    caller: mcpCallerValidator,
    narrative: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  returns: v.object({
    reportId: v.id("endOfDayReports"),
    window: windowValidator,
    repeated: v.boolean(),
    slackStatus: v.string(),
    message: v.string(),
  }),
  handler: async (ctx, { caller, narrative, note }) => {
    const me = await requireMcpUser(ctx, caller, ["closer"]);
    const startedAt = Date.now();
    const report = await endDayCore(ctx, me, {
      narrative,
      note,
      endedVia: "agent",
      agentClient: me.agentClient,
    });
    // Ending twice within a minute returns the first report (§5.6).
    const repeated = report.createdAt < startedAt;
    const seconds = Math.max(1, Math.round((startedAt - report.createdAt) / 1000));
    return {
      reportId: report._id,
      window: {
        from: formatLocal(report.periodStart, report.timeZone),
        to: formatLocal(report.periodEnd, report.timeZone),
        previousDayUnclosed: report.previousDayUnclosed,
      },
      repeated,
      slackStatus: report.slackStatus,
      message: repeated
        ? `You ended your day ${seconds} seconds ago. Here's that report. ${slackLine(report)}`
        : slackLine(report),
    };
  },
});
