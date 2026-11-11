import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, env } from "../_generated/server";
import { emitDomainEventInAction } from "../lib/domainEventsAction";
import {
  buildLeadGenSubmissionNotification,
  buildQualifiedLeadConfirmation,
} from "../lib/slackBlockKit";
import { log } from "../lib/observability/log";
import {
  logSlackNotifyPosted,
  logSlackNotifySkipped,
  reportSlackNotifyFailed,
} from "./notifyObservability";
import { getValidSlackBotToken, logSlackTokenUnavailable } from "./tokens";
import { slackApiPostJson, slackClientMessageId } from "./webApi";

const CLEAR_CHANNEL_ERRORS = new Set(["channel_not_found", "is_archived"]);
const ACTION_REQUIRED_ERRORS = new Set([
  "channel_not_found",
  "is_archived",
  "not_in_channel",
]);

/** Waits before the second and third attempts at a lead gen post. */
const LEAD_GEN_POST_RETRY_DELAYS_MS = [15_000, 60_000];

/**
 * Failures worth another attempt: the request never got an answer
 * (`transport_error`), Slack is rate limiting, or Slack is failing.
 */
function isRetryableSlackError(slackErr: string) {
  return (
    slackErr === "transport_error" ||
    slackErr === "ratelimited" ||
    /^http_(429|5\d\d)$/.test(slackErr)
  );
}

export const postConfirmation = internalAction({
  args: {
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    // Optional so jobs scheduled before the snapshot fields still validate.
    qualificationEventId: v.optional(v.id("slackQualificationEvents")),
  },
  handler: async (ctx, args) => {
    const installation = await ctx.runQuery(
      internal.slack.installations.byTenantId,
      { tenantId: args.tenantId },
    );
    const kind = "qualified_lead" as const;
    if (!installation || installation.status !== "active") {
      logSlackNotifySkipped("installation_not_active", {
        tenantId: args.tenantId,
        kind,
        installationStatus: installation?.status ?? "missing",
      });
      return;
    }
    if (!installation.notifyChannelId) {
      logSlackNotifySkipped("no_channel_configured", {
        tenantId: args.tenantId,
        installationId: installation._id,
        kind,
      });
      return;
    }
    const notifyAttrs = {
      tenantId: args.tenantId,
      installationId: installation._id,
      kind,
      channelId: installation.notifyChannelId,
      opportunityId: args.opportunityId,
    };

    const qualified = await ctx.runQuery(
      internal.slack.notifyData.getQualifiedLeadForNotify,
      {
        tenantId: args.tenantId,
        opportunityId: args.opportunityId,
        leadId: args.leadId,
        qualificationEventId: args.qualificationEventId,
      },
    );
    const qualificationGoal = await ctx.runQuery(
      internal.slack.notifyData.getQualificationGoalProgress,
      { tenantId: args.tenantId, now: Date.now() },
    );

    if (!qualified) {
      reportSlackNotifyFailed("missing_notification_data", {
        ...notifyAttrs,
        leadId: args.leadId,
        qualificationEventId: args.qualificationEventId,
      });
      return;
    }

    const appUrl = env.APP_URL;
    if (!appUrl) {
      reportSlackNotifyFailed("app_url_not_configured", notifyAttrs);
      await emitDomainEventInAction(ctx, {
        tenantId: args.tenantId,
        entityType: "slackInstallation",
        entityId: installation._id,
        eventType: "slack.notify.failed",
        source: "system",
        occurredAt: Date.now(),
        metadata: {
          slackErr: "app_url_not_configured",
          channel: installation.notifyChannelId,
          opportunityId: args.opportunityId,
        },
      });
      return;
    }

    const message = buildQualifiedLeadConfirmation({
      ...qualified,
      qualificationGoal: qualificationGoal ?? undefined,
      appUrl,
      opportunityId: args.opportunityId,
    });

    let token: string;
    try {
      token = await getValidSlackBotToken(ctx, args.tenantId);
    } catch (error) {
      logSlackTokenUnavailable("slack.notify.token_unavailable", error, notifyAttrs);
      return;
    }

    const response = await slackApiPostJson<{ channel?: string; ts?: string }>(
      "chat.postMessage",
      token,
      {
        channel: installation.notifyChannelId,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
        unfurl_media: false,
      },
    );

    if (response.ok) {
      logSlackNotifyPosted(notifyAttrs);
      return;
    }

    const slackErr = response.error ?? "unknown";
    reportSlackNotifyFailed(slackErr, notifyAttrs);

    if (ACTION_REQUIRED_ERRORS.has(slackErr)) {
      await ctx.runMutation(internal.slack.notifyData.recordNotifyFailure, {
        installationId: installation._id,
        slackErr,
        clearChannel: CLEAR_CHANNEL_ERRORS.has(slackErr),
      });
    }

    await emitDomainEventInAction(ctx, {
      tenantId: args.tenantId,
      entityType: "slackInstallation",
      entityId: installation._id,
      eventType: "slack.notify.failed",
      source: "system",
      occurredAt: Date.now(),
      metadata: {
        slackErr,
        channel: installation.notifyChannelId,
        opportunityId: args.opportunityId,
      },
    });
  },
});

export const postExistingOpportunityBump = internalAction({
  args: {
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    qualificationEventId: v.id("slackQualificationEvents"),
  },
  handler: async (ctx, args) => {
    const installation = await ctx.runQuery(
      internal.slack.installations.byTenantId,
      { tenantId: args.tenantId },
    );
    const kind = "existing_opportunity_bump" as const;
    if (!installation || installation.status !== "active") {
      logSlackNotifySkipped("installation_not_active", {
        tenantId: args.tenantId,
        kind,
        installationStatus: installation?.status ?? "missing",
      });
      return;
    }
    if (!installation.notifyChannelId) {
      logSlackNotifySkipped("no_channel_configured", {
        tenantId: args.tenantId,
        installationId: installation._id,
        kind,
      });
      return;
    }
    const notifyAttrs = {
      tenantId: args.tenantId,
      installationId: installation._id,
      kind,
      channelId: installation.notifyChannelId,
      opportunityId: args.opportunityId,
    };

    const bump = await ctx.runQuery(
      internal.slack.notifyData.getExistingOpportunityBumpForNotify,
      {
        tenantId: args.tenantId,
        opportunityId: args.opportunityId,
        leadId: args.leadId,
        qualificationEventId: args.qualificationEventId,
      },
    );

    if (!bump) {
      reportSlackNotifyFailed("missing_notification_data", {
        ...notifyAttrs,
        leadId: args.leadId,
        qualificationEventId: args.qualificationEventId,
      });
      return;
    }

    const appUrl = env.APP_URL;
    if (!appUrl) {
      reportSlackNotifyFailed("app_url_not_configured", notifyAttrs);
      await emitDomainEventInAction(ctx, {
        tenantId: args.tenantId,
        entityType: "slackInstallation",
        entityId: installation._id,
        eventType: "slack.notify.failed",
        source: "system",
        occurredAt: Date.now(),
        metadata: {
          slackErr: "app_url_not_configured",
          channel: installation.notifyChannelId,
          opportunityId: args.opportunityId,
          notificationKind: "existing_opportunity_bump",
        },
      });
      return;
    }

    const qualificationGoal = await ctx.runQuery(
      internal.slack.notifyData.getQualificationGoalProgress,
      { tenantId: args.tenantId, now: Date.now() },
    );

    const message = buildQualifiedLeadConfirmation({
      leadFullName: bump.leadFullName,
      platform: bump.platform,
      handle: bump.handle,
      country: bump.country,
      leadType: bump.leadType,
      qualifiedBySlackUserId: bump.bumpedBySlackUserId,
      submittedAt: bump.submittedAt,
      qualificationGoal: qualificationGoal ?? undefined,
      appUrl,
      opportunityId: args.opportunityId,
    });

    let token: string;
    try {
      token = await getValidSlackBotToken(ctx, args.tenantId);
    } catch (error) {
      logSlackTokenUnavailable("slack.notify.token_unavailable", error, notifyAttrs);
      return;
    }

    const response = await slackApiPostJson<{ channel?: string; ts?: string }>(
      "chat.postMessage",
      token,
      {
        channel: installation.notifyChannelId,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
        unfurl_media: false,
      },
    );

    if (response.ok) {
      logSlackNotifyPosted(notifyAttrs);
      return;
    }

    const slackErr = response.error ?? "unknown";
    reportSlackNotifyFailed(slackErr, notifyAttrs);

    if (ACTION_REQUIRED_ERRORS.has(slackErr)) {
      await ctx.runMutation(internal.slack.notifyData.recordNotifyFailure, {
        installationId: installation._id,
        slackErr,
        clearChannel: CLEAR_CHANNEL_ERRORS.has(slackErr),
      });
    }

    await emitDomainEventInAction(ctx, {
      tenantId: args.tenantId,
      entityType: "slackInstallation",
      entityId: installation._id,
      eventType: "slack.notify.failed",
      source: "system",
      occurredAt: Date.now(),
      metadata: {
        slackErr,
        channel: installation.notifyChannelId,
        opportunityId: args.opportunityId,
        notificationKind: "existing_opportunity_bump",
      },
    });
  },
});

/**
 * Posts a lead gen submission to the tenant's lead gen channel.
 *
 * Convex never retries a scheduled action, so a post Slack doesn't answer
 * schedules itself again, three attempts in all. An unanswered request may
 * still have reached Slack, so every attempt sends the same `client_msg_id`,
 * made from the submission id. Each attempt starts from the top: it posts
 * nothing once the submission is voided or the channel is turned off or
 * changed.
 */
export const postLeadGenSubmission = internalAction({
  args: {
    tenantId: v.id("tenants"),
    submissionId: v.id("leadGenSubmissions"),
    // 1-based. Optional so posts scheduled before retries still validate.
    attempt: v.optional(v.number()),
    // The channel the first attempt posted to, on a retry.
    channelId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const attempt = args.attempt ?? 1;
    const installation = await ctx.runQuery(
      internal.slack.installations.byTenantId,
      { tenantId: args.tenantId },
    );
    const kind = "lead_gen_submission" as const;
    if (!installation || installation.status !== "active") {
      logSlackNotifySkipped("installation_not_active", {
        tenantId: args.tenantId,
        kind,
        installationStatus: installation?.status ?? "missing",
      });
      return;
    }
    // Opt-in: the channel may have been turned off after scheduling.
    const channelId = installation.leadGenNotifyChannelId;
    if (!channelId) {
      logSlackNotifySkipped("no_channel_configured", {
        tenantId: args.tenantId,
        installationId: installation._id,
        kind,
      });
      return;
    }
    const notifyAttrs = {
      tenantId: args.tenantId,
      installationId: installation._id,
      kind,
      channelId,
      submissionId: args.submissionId,
    };
    // Slack can't match a repeat in another channel to the post it repeats.
    if (args.channelId !== undefined && args.channelId !== channelId) {
      logSlackNotifySkipped("channel_changed", notifyAttrs);
      return;
    }

    const submission = await ctx.runQuery(
      internal.slack.notifyData.getLeadGenSubmissionForNotify,
      { tenantId: args.tenantId, submissionId: args.submissionId },
    );
    if (!submission) {
      reportSlackNotifyFailed("missing_notification_data", notifyAttrs);
      return;
    }
    if (submission.kind === "voided") {
      logSlackNotifySkipped("submission_voided", notifyAttrs);
      return;
    }

    const message = buildLeadGenSubmissionNotification(submission);

    let token: string;
    try {
      token = await getValidSlackBotToken(ctx, args.tenantId);
    } catch (error) {
      logSlackTokenUnavailable("slack.notify.token_unavailable", error, notifyAttrs);
      return;
    }

    let slackErr: string;
    let retryAfterMs = 0;
    try {
      const response = await slackApiPostJson<{ channel?: string; ts?: string }>(
        "chat.postMessage",
        token,
        {
          channel: channelId,
          text: message.text,
          blocks: message.blocks,
          client_msg_id: await slackClientMessageId(args.submissionId),
          unfurl_links: false,
          unfurl_media: false,
        },
      );
      if (response.ok) {
        logSlackNotifyPosted({ ...notifyAttrs, attempt });
        return;
      }
      slackErr = response.error ?? "unknown";
      retryAfterMs = (response.retryAfterSeconds ?? 0) * 1000;
    } catch {
      // The request failed or timed out with no answer. Slack may or may
      // not have the message.
      slackErr = "transport_error";
    }

    const backoffMs = LEAD_GEN_POST_RETRY_DELAYS_MS[attempt - 1];
    if (isRetryableSlackError(slackErr) && backoffMs !== undefined) {
      // Never sooner than Slack's `Retry-After`: an attempt made during
      // its cooldown fails too, and would use up the attempts.
      const retryDelayMs = Math.max(backoffMs, retryAfterMs);
      log.warn("slack.notify.retry_scheduled", {
        ...notifyAttrs,
        slackErr,
        attempt,
        retryDelayMs,
      });
      await ctx.scheduler.runAfter(
        retryDelayMs,
        internal.slack.notify.postLeadGenSubmission,
        {
          tenantId: args.tenantId,
          submissionId: args.submissionId,
          attempt: attempt + 1,
          channelId,
        },
      );
      return;
    }

    reportSlackNotifyFailed(slackErr, notifyAttrs, {
      operation: "chat.postMessage",
      attempts: attempt,
    });

    if (ACTION_REQUIRED_ERRORS.has(slackErr)) {
      await ctx.runMutation(internal.slack.notifyData.recordLeadGenNotifyFailure, {
        installationId: installation._id,
        channelId,
        slackErr,
        clearChannel: CLEAR_CHANNEL_ERRORS.has(slackErr),
      });
    }

    await emitDomainEventInAction(ctx, {
      tenantId: args.tenantId,
      entityType: "slackInstallation",
      entityId: installation._id,
      eventType: "slack.notify.failed",
      source: "system",
      occurredAt: Date.now(),
      metadata: {
        slackErr,
        channel: channelId,
        submissionId: args.submissionId,
        notificationKind: "lead_gen_submission",
      },
    });
  },
});
