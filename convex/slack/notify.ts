import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, env } from "../_generated/server";
import { emitDomainEventInAction } from "../lib/domainEventsAction";
import { buildQualifiedLeadConfirmation } from "../lib/slackBlockKit";
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

    const opportunity = await ctx.runQuery(
      internal.slack.notifyData.getOppForNotify,
      { opportunityId: args.opportunityId },
    );
    const lead = await ctx.runQuery(internal.slack.notifyData.getLeadForNotify, {
      leadId: args.leadId,
    });
    const identifier = await ctx.runQuery(
      internal.slack.notifyData.getPrimarySocialIdentifier,
      { leadId: args.leadId },
    );
    const qualificationGoal = await ctx.runQuery(
      internal.slack.notifyData.getQualificationGoalProgress,
      { tenantId: args.tenantId, now: Date.now() },
    );

    if (!opportunity || !lead || !identifier || !opportunity.qualifiedBy) {
      reportSlackNotifyFailed("missing_notification_data", {
        ...notifyAttrs,
        hasOpportunity: Boolean(opportunity),
        hasLead: Boolean(lead),
        hasIdentifier: Boolean(identifier),
        hasQualifiedBy: Boolean(opportunity?.qualifiedBy),
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
      leadFullName: lead.fullName ?? lead.email ?? "Lead",
      platform: identifier.platform,
      handle: identifier.rawValue,
      country: lead.country,
      leadType: lead.leadType,
      qualifiedBySlackUserId: opportunity.qualifiedBy.slackUserId,
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
