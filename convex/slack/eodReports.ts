import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import schema from "../schema";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { log, reportError } from "../lib/observability/log";
import { buildEndOfDayMessage } from "./eodMessage";
import { getValidSlackBotToken, logSlackTokenUnavailable } from "./tokens";
import { slackApiPostJson } from "./webApi";

export const getForPost = internalQuery({
  args: { reportId: v.id("endOfDayReports") },
  returns: v.union(
    v.null(),
    v.object({
      report: schema.doc("endOfDayReports"),
      closerName: v.string(),
      businessZone: v.string(),
      threadTs: v.union(v.string(), v.null()),
      threadPending: v.boolean(),
    }),
  ),
  handler: async (ctx, { reportId }) => {
    const report = await ctx.db.get("endOfDayReports", reportId);
    if (!report || report.slackStatus !== "pending") return null;
    const [user, setting, root] = await Promise.all([
      ctx.db.get("users", report.userId),
      getTenantBusinessDay(ctx, report.tenantId),
      report.slackThreadReportId
        ? ctx.db.get("endOfDayReports", report.slackThreadReportId)
        : null,
    ]);
    const validRoot =
      root?.tenantId === report.tenantId &&
      root.userId === report.userId &&
      root.slackChannelId === report.slackChannelId
        ? root
        : null;
    return {
      report,
      closerName: user?.fullName ?? user?.calendlyMemberName ?? "Closer",
      businessZone: setting.timeZone,
      threadTs: report.slackThreadTs ?? validRoot?.slackTs ?? null,
      threadPending: validRoot?.slackStatus === "pending",
    };
  },
});

export const completePost = internalMutation({
  args: {
    reportId: v.id("endOfDayReports"),
    channelId: v.string(),
    ts: v.optional(v.string()),
    threadTs: v.optional(v.string()),
    error: v.optional(v.string()),
    attempt: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const report = await ctx.db.get("endOfDayReports", args.reportId);
    if (
      !report ||
      report.slackStatus !== "pending" ||
      report.slackChannelId !== args.channelId
    )
      return null;
    if (report.slackPostAttempt !== args.attempt) return null;
    await ctx.db.patch(
      "endOfDayReports",
      report._id,
      args.ts
        ? {
            slackStatus: "posted",
            slackTs: args.ts,
            slackThreadTs: args.threadTs,
            postedAt: Date.now(),
            slackError: undefined,
          }
        : { slackStatus: "failed", slackError: args.error ?? "unknown" },
    );
    await ctx.db.patch("endOfDayReports", report._id, {
      slackPostStartedAt: undefined,
      slackPostAttempt: undefined,
    });
    const installation = await ctx.db
      .query("slackInstallations")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", report.tenantId))
      .first();
    // A channel changed while fetch was in flight must keep its own state.
    if (!installation || installation.eodReportChannelId !== args.channelId)
      return null;
    if (args.ts) {
      await ctx.db.patch("slackInstallations", installation._id, {
        eodReportChannelError: undefined,
      });
    } else if (
      args.error &&
      ["channel_not_found", "is_archived", "not_in_channel"].includes(
        args.error,
      )
    ) {
      await ctx.db.patch("slackInstallations", installation._id, {
        ...(["channel_not_found", "is_archived"].includes(args.error) && {
          eodReportChannelId: undefined,
          eodReportChannelName: undefined,
        }),
        eodReportChannelError: {
          code: args.error,
          channelId: args.channelId,
          channelName: installation.eodReportChannelName,
          occurredAt: Date.now(),
        },
      });
    }
    return null;
  },
});

export const claimPost = internalMutation({
  args: { reportId: v.id("endOfDayReports"), attempt: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { reportId, attempt }) => {
    const report = await ctx.db.get("endOfDayReports", reportId);
    if (
      !report ||
      report.slackStatus !== "pending" ||
      (report.slackPostStartedAt !== undefined &&
        Date.now() - report.slackPostStartedAt < 120_000)
    )
      return false;
    await ctx.db.patch("endOfDayReports", reportId, {
      slackPostStartedAt: Date.now(),
      slackPostAttempt: attempt,
    });
    return true;
  },
});

export const post = internalAction({
  args: {
    reportId: v.id("endOfDayReports"),
    threadWaits: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { reportId, threadWaits = 0 }) => {
    const data = await ctx.runQuery(internal.slack.eodReports.getForPost, {
      reportId,
    });
    if (!data) return null;
    const { report, threadTs } = data;
    const channelId = report.slackChannelId;
    if (!channelId) return null;
    const finish = async (error: string, attempt?: string) => {
      await ctx.runMutation(internal.slack.eodReports.completePost, {
        reportId,
        channelId,
        error,
        attempt,
      });
    };
    if (data.threadPending) {
      // Two reports can be queued before Slack answers the first. Preserve
      // the thread rather than posting a second top-level message.
      if (threadWaits >= 30) {
        await finish("thread_pending");
        return null;
      }
      await ctx.scheduler.runAfter(2000, internal.slack.eodReports.post, {
        reportId,
        threadWaits: threadWaits + 1,
      });
      return null;
    }
    const installation = await ctx.runQuery(
      internal.slack.installations.byTenantId,
      { tenantId: report.tenantId },
    );
    if (
      !installation ||
      installation.status !== "active" ||
      installation.eodReportChannelId !== channelId
    ) {
      await finish("channel_changed_or_disconnected");
      return null;
    }
    const attempt = crypto.randomUUID();
    if (
      !(await ctx.runMutation(internal.slack.eodReports.claimPost, {
        reportId,
        attempt,
      }))
    )
      return null;
    let token: string;
    try {
      token = await getValidSlackBotToken(ctx, report.tenantId);
    } catch (error) {
      logSlackTokenUnavailable("slack.eod.token_unavailable", error, {
        reportId,
        tenantId: report.tenantId,
      });
      await finish("token_unavailable", attempt);
      return null;
    }
    try {
      const message = buildEndOfDayMessage(
        report,
        data.closerName,
        data.businessZone,
      );
      // A stable Slack id also protects a retry after a network interruption.
      const hash = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(reportId),
        ),
      );
      const hex = [...hash]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const clientMessageId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      const response = await slackApiPostJson<{ ts?: string }>(
        "chat.postMessage",
        token,
        {
          channel: channelId,
          ...message,
          ...(threadTs && { thread_ts: threadTs }),
          client_msg_id: clientMessageId,
          unfurl_links: false,
          unfurl_media: false,
        },
      );
      if (response.ok && response.ts) {
        await ctx.runMutation(internal.slack.eodReports.completePost, {
          reportId,
          channelId,
          ts: response.ts,
          attempt,
          ...(threadTs && { threadTs }),
        });
        log.info("slack.eod.posted", {
          reportId,
          tenantId: report.tenantId,
          channelId,
        });
      } else {
        const error = response.ok
          ? "missing_ts"
          : (response.error ?? "unknown");
        await finish(error, attempt);
        log.warn("slack.eod.failed", {
          reportId,
          tenantId: report.tenantId,
          channelId,
          error,
        });
      }
    } catch (error) {
      reportError("slack.eod.failed", error, {
        integration: "slack",
        reportId,
        tenantId: report.tenantId,
        channelId,
      });
      await finish("post_failed", attempt);
    }
    return null;
  },
});
