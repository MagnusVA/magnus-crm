import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { SHIFT_POST_LEASE_MS } from "../leadGen/endOfShift";
import { log, reportError } from "../lib/observability/log";
import { sha256Hex } from "../mcp/confirm";
import schema from "../schema";
import { buildLeadGenShiftMessage } from "./leadGenShiftMessage";
import { getValidSlackBotToken, logSlackTokenUnavailable } from "./tokens";
import { slackApiPostJson } from "./webApi";

export const getForPost = internalQuery({
  args: { reportId: v.id("leadGenShiftReports") },
  returns: v.union(v.null(), v.object({ report: schema.doc("leadGenShiftReports"), workerName: v.string() })),
  handler: async (ctx, { reportId }) => {
    const report = await ctx.db.get("leadGenShiftReports", reportId);
    if (!report || report.slackStatus !== "pending") return null;
    const worker = await ctx.db.get("leadGenWorkers", report.workerId);
    if (!worker || worker.tenantId !== report.tenantId || worker.userId !== report.userId) return null;
    return { report, workerName: (worker.displayName ?? "Lead generator").slice(0, 100) };
  },
});

export const claimPost = internalMutation({
  args: { reportId: v.id("leadGenShiftReports"), channelId: v.string(), attempt: v.string() }, returns: v.boolean(),
  handler: async (ctx, { reportId, channelId, attempt }) => {
    const report = await ctx.db.get("leadGenShiftReports", reportId);
    if (!report || report.slackStatus !== "pending" || report.slackChannelId !== channelId ||
        (report.slackPostAttempt !== undefined && report.slackPostStartedAt !== undefined && Date.now() - report.slackPostStartedAt < SHIFT_POST_LEASE_MS)) return false;
    await ctx.db.patch("leadGenShiftReports", reportId, { slackPostStartedAt: Date.now(), slackPostAttempt: attempt });
    return true;
  },
});

export const completePost = internalMutation({
  args: { reportId: v.id("leadGenShiftReports"), channelId: v.string(), attempt: v.string(), ts: v.optional(v.string()), error: v.optional(v.string()) }, returns: v.null(),
  handler: async (ctx, args) => {
    const report = await ctx.db.get("leadGenShiftReports", args.reportId);
    if (!report || report.slackStatus !== "pending" || report.slackChannelId !== args.channelId || report.slackPostAttempt !== args.attempt) return null;
    await ctx.db.patch("leadGenShiftReports", report._id, { slackPostStartedAt: undefined, slackPostAttempt: undefined,
      ...(args.ts ? { slackStatus: "posted" as const, slackTs: args.ts, postedAt: Date.now(), slackError: undefined }
        : { slackStatus: "failed" as const, slackError: args.error ?? "unknown" }) });
    const installation = await ctx.db.query("slackInstallations").withIndex("by_tenantId", q => q.eq("tenantId", report.tenantId)).first();
    if (!installation || installation.leadGenNotifyChannelId !== args.channelId) return null;
    if (args.ts) await ctx.db.patch("slackInstallations", installation._id, { leadGenNotifyChannelError: undefined });
    else if (args.error && ["channel_not_found", "is_archived", "not_in_channel"].includes(args.error)) {
      await ctx.db.patch("slackInstallations", installation._id, {
        ...(["channel_not_found", "is_archived"].includes(args.error) && { leadGenNotifyChannelId: undefined, leadGenNotifyChannelName: undefined }),
        leadGenNotifyChannelError: { code: args.error, channelId: args.channelId, channelName: installation.leadGenNotifyChannelName, occurredAt: Date.now() },
      });
    }
    return null;
  },
});

export const post = internalAction({
  args: { reportId: v.id("leadGenShiftReports") }, returns: v.null(),
  handler: async (ctx, { reportId }) => {
    const data = await ctx.runQuery(internal.slack.leadGenShiftReports.getForPost, { reportId });
    if (!data?.report.slackChannelId) return null;
    const { report, workerName } = data;
    const channelId = report.slackChannelId!;
    const attempt = crypto.randomUUID();
    if (!await ctx.runMutation(internal.slack.leadGenShiftReports.claimPost, { reportId, channelId, attempt })) return null;
    const finish = async (result: { ts?: string; error?: string }) => {
      await ctx.runMutation(internal.slack.leadGenShiftReports.completePost, { reportId, channelId, attempt, ...result });
    };
    const installation = await ctx.runQuery(internal.slack.installations.byTenantId, { tenantId: report.tenantId });
    if (installation?.status !== "active" || installation.leadGenNotifyChannelId !== channelId) {
      await finish({ error: "channel_changed_or_disconnected" });
      return null;
    }
    let token: string;
    try { token = await getValidSlackBotToken(ctx, report.tenantId); }
    catch (error) {
      logSlackTokenUnavailable("slack.lead_gen_shift.token_unavailable", error, { reportId, tenantId: report.tenantId });
      await finish({ error: "token_unavailable" });
      return null;
    }
    try {
      const hex = await sha256Hex(reportId);
      const clientMessageId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      const response = await slackApiPostJson<{ ts?: string }>("chat.postMessage", token, {
        channel: channelId, ...buildLeadGenShiftMessage(report, workerName), client_msg_id: clientMessageId, unfurl_links: false, unfurl_media: false,
      });
      await finish(response.ok && response.ts ? { ts: response.ts } : { error: response.ok ? "missing_ts" : response.error ?? "unknown" });
      log.info("slack.lead_gen_shift.completed", { reportId, tenantId: report.tenantId, posted: response.ok && Boolean(response.ts) });
    } catch (error) {
      reportError("slack.lead_gen_shift.failed", error, { integration: "slack", reportId, tenantId: report.tenantId, channelId });
      await finish({ error: "post_failed" });
    }
    return null;
  },
});
