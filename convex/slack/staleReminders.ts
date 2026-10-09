import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, env } from "../_generated/server";
import { emitDomainEventInAction } from "../lib/domainEventsAction";
import { log } from "../lib/observability/log";
import {
  buildStaleDigest,
  type StaleLeadDigestEntry,
} from "../lib/slackBlockKit";
import {
  logSlackNotifyPosted,
  logSlackNotifySkipped,
  reportSlackNotifyFailed,
} from "./notifyObservability";
import { getValidSlackBotToken, logSlackTokenUnavailable } from "./tokens";
import { slackApiPostJson } from "./webApi";

const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_FAN_OUT_LIMIT_PER_TENANT = 25;
const CLEAR_CHANNEL_ERRORS = new Set(["channel_not_found", "is_archived"]);
const ACTION_REQUIRED_ERRORS = new Set([
  "channel_not_found",
  "is_archived",
  "not_in_channel",
]);

type StaleOpportunityDigestRow = {
  opportunityId: string;
  createdAt: number;
  leadFullName: string | null;
  leadEmail: string | null;
  platform: StaleLeadDigestEntry["platform"];
  handle: string;
  qualifiedBySlackUserId: string;
};

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

    log.info("slack.stale_digest.fan_out", { installationCount: ids.length });

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

    const kind = "stale_digest" as const;
    if (!channelId) {
      logSlackNotifySkipped("no_channel_configured", {
        tenantId: installation.tenantId,
        installationId: installation._id,
        kind,
      });
      return;
    }
    const notifyAttrs = {
      tenantId: installation.tenantId,
      installationId: installation._id,
      kind,
      channelId,
      channelKind,
    };

    const stale: {
      opps: StaleOpportunityDigestRow[];
      hasMore: boolean;
    } = await ctx.runQuery(
      internal.slack.staleRemindersData.listStaleOpportunities,
      {
        tenantId: installation.tenantId,
        cutoff: Date.now() - STALE_THRESHOLD_MS,
        limit: STALE_FAN_OUT_LIMIT_PER_TENANT,
      },
    );

    if (stale.opps.length === 0) {
      logSlackNotifySkipped("no_stale_leads", notifyAttrs);
      return;
    }

    const appUrl = env.APP_URL;
    if (!appUrl) {
      reportSlackNotifyFailed("app_url_not_configured", notifyAttrs);
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
      logSlackTokenUnavailable("slack.notify.token_unavailable", error, notifyAttrs);
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
      logSlackNotifyPosted({
        ...notifyAttrs,
        entryCount: entries.length,
        hasMore: stale.hasMore,
      });
      return;
    }

    const slackErr = response.error ?? "unknown";
    reportSlackNotifyFailed(slackErr, notifyAttrs);

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
