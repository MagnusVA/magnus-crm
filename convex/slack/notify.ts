import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, env } from "../_generated/server";
import { emitDomainEventInAction } from "../lib/domainEventsAction";
import {
  buildLeadGenSubmissionNotification,
  buildQualifiedLeadConfirmation,
} from "../lib/slackBlockKit";
import {
  logSlackNotifyPosted,
  logSlackNotifySkipped,
  reportSlackNotifyFailed,
} from "./notifyObservability";
import { getValidSlackBotToken, logSlackTokenUnavailable } from "./tokens";
import { slackApiPostJson } from "./webApi";

const CLEAR_CHANNEL_ERRORS = new Set(["channel_not_found", "is_archived"]);
const ACTION_REQUIRED_ERRORS = new Set([
  "channel_not_found",
  "is_archived",
  "not_in_channel",
]);

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

export const postLeadGenSubmission = internalAction({
  args: {
    tenantId: v.id("tenants"),
    submissionId: v.id("leadGenSubmissions"),
  },
  handler: async (ctx, args) => {
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
      logSlackNotifyPosted(notifyAttrs);
      return;
    }

    const slackErr = response.error ?? "unknown";
    reportSlackNotifyFailed(slackErr, notifyAttrs);

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
