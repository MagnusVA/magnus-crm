import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { emitDomainEventInAction } from "../lib/domainEventsAction";
import {
  buildStaleDigest,
  type StaleLeadDigestEntry,
} from "../lib/slackBlockKit";
import { getValidSlackBotToken } from "./tokens";
import { slackApiPostJson } from "./webApi";

const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_FAN_OUT_LIMIT_PER_TENANT = 25;
const CLEAR_CHANNEL_ERRORS = new Set(["channel_not_found", "is_archived"]);
const ACTION_REQUIRED_ERRORS = new Set([
  "channel_not_found",
  "is_archived",
  "not_in_channel",
]);

export const maybeRun = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = new Date();
    const hourInNY = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        hour12: false,
      }).format(now),
    );

    if (hourInNY !== 8) return;

    console.log("[Slack:Stale] cron fired (08:00 NY)");
    await ctx.scheduler.runAfter(0, internal.slack.staleReminders.fanOut, {});
  },
});

export const fanOut = internalAction({
  args: {},
  handler: async (ctx) => {
    const ids = await ctx.runQuery(
      internal.slack.staleRemindersData.listActiveInstallationIds,
      {},
    );

    console.log("[Slack:Stale] fan-out", { tenantCount: ids.length });

    for (const installationId of ids) {
      await ctx.scheduler.runAfter(
        0,
        internal.slack.staleReminders.postForTenant,
        { installationId },
      );
    }
  },
});

export const postForTenant = internalAction({
  args: { installationId: v.id("slackInstallations") },
  handler: async (ctx, args) => {
    const installation = await ctx.runQuery(internal.slack.installations.byId, {
      id: args.installationId,
    });
    if (!installation || installation.status !== "active") return;

    const channelKind = installation.staleReminderChannelId
      ? "staleReminder"
      : "notify";
    const channelId =
      installation.staleReminderChannelId ?? installation.notifyChannelId;

    if (!channelId) {
      console.log("[Slack:Stale] skipping - no channel configured", {
        tenantId: installation.tenantId,
      });
      return;
    }

    const stale = await ctx.runQuery(
      internal.slack.staleRemindersData.listStaleOpportunities,
      {
        tenantId: installation.tenantId,
        cutoff: Date.now() - STALE_THRESHOLD_MS,
        limit: STALE_FAN_OUT_LIMIT_PER_TENANT,
      },
    );

    if (stale.opps.length === 0) {
      console.log("[Slack:Stale] no stale leads", {
        tenantId: installation.tenantId,
      });
      return;
    }

    const appUrl = process.env.APP_URL;
    if (!appUrl) {
      console.warn("[Slack:Stale] APP_URL not configured", {
        tenantId: installation.tenantId,
      });
      await emitDomainEventInAction(ctx, {
        tenantId: installation.tenantId,
        entityType: "slackInstallation",
        entityId: installation._id,
        eventType: "slack.stale.failed",
        source: "system",
        occurredAt: Date.now(),
        metadata: { slackErr: "app_url_not_configured", channel: channelId },
      });
      return;
    }
    const entries: StaleLeadDigestEntry[] = stale.opps.map((row) => ({
      leadFullName: row.leadFullName ?? row.leadEmail ?? "Lead",
      platform: row.platform,
      handle: row.handle,
      daysOld: Math.floor((Date.now() - row.createdAt) / (24 * 60 * 60 * 1000)),
      appUrl,
      opportunityId: row.opportunityId,
      qualifiedBySlackUserId: row.qualifiedBySlackUserId,
    }));
    const message = buildStaleDigest({
      entries,
      hasMore: stale.hasMore,
      appUrl,
    });

    let token: string;
    try {
      token = await getValidSlackBotToken(ctx, installation.tenantId);
    } catch (error) {
      console.warn("[Slack:Stale] token unavailable", {
        tenantId: installation.tenantId,
        error: error instanceof Error ? error.message : "unknown",
      });
      return;
    }

    const response = await slackApiPostJson<{ channel?: string; ts?: string }>(
      "chat.postMessage",
      token,
      {
        channel: channelId,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
        unfurl_media: false,
      },
    );

    if (response.ok) {
      console.log("[Slack:Stale] posted", {
        tenantId: installation.tenantId,
        channel: channelId,
        count: entries.length,
      });
      return;
    }

    const slackErr = response.error ?? "unknown";
    console.warn("[Slack:Stale] post failed", {
      tenantId: installation.tenantId,
      slackErr,
    });

    if (ACTION_REQUIRED_ERRORS.has(slackErr)) {
      await ctx.runMutation(
        internal.slack.staleRemindersData.recordChannelFailure,
        {
          installationId: installation._id,
          channelKind,
          slackErr,
          clearChannel: CLEAR_CHANNEL_ERRORS.has(slackErr),
        },
      );
    }

    await emitDomainEventInAction(ctx, {
      tenantId: installation.tenantId,
      entityType: "slackInstallation",
      entityId: installation._id,
      eventType: "slack.stale.failed",
      source: "system",
      occurredAt: Date.now(),
      metadata: { slackErr, channel: channelId },
    });
  },
});
