import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { emitDomainEventInAction } from "../lib/domainEventsAction";
import { buildQualifiedLeadConfirmation } from "../lib/slackBlockKit";
import { getValidSlackBotToken } from "./tokens";
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
    if (!installation || installation.status !== "active") {
      console.log("[Slack:Notify] skipping - installation not active", {
        tenantId: args.tenantId,
        status: installation?.status,
      });
      return;
    }
    if (!installation.notifyChannelId) {
      console.log("[Slack:Notify] skipping - no notify channel configured", {
        tenantId: args.tenantId,
      });
      return;
    }

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

    if (!opportunity || !lead || !identifier || !opportunity.qualifiedBy) {
      console.warn("[Slack:Notify] missing notification data", {
        tenantId: args.tenantId,
        opportunityId: args.opportunityId,
        hasOpportunity: Boolean(opportunity),
        hasLead: Boolean(lead),
        hasIdentifier: Boolean(identifier),
      });
      return;
    }

    const appUrl = process.env.APP_URL;
    if (!appUrl) {
      console.warn("[Slack:Notify] APP_URL not configured", {
        tenantId: args.tenantId,
        opportunityId: args.opportunityId,
      });
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
      qualifiedBySlackUserId: opportunity.qualifiedBy.slackUserId,
      appUrl,
      opportunityId: args.opportunityId,
    });

    let token: string;
    try {
      token = await getValidSlackBotToken(ctx, args.tenantId);
    } catch (error) {
      console.warn("[Slack:Notify] token unavailable", {
        tenantId: args.tenantId,
        error: error instanceof Error ? error.message : "unknown",
      });
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
      console.log("[Slack:Notify] posted", {
        tenantId: args.tenantId,
        channel: installation.notifyChannelId,
        opportunityId: args.opportunityId,
      });
      return;
    }

    const slackErr = response.error ?? "unknown";
    console.warn("[Slack:Notify] post failed", {
      tenantId: args.tenantId,
      channel: installation.notifyChannelId,
      slackErr,
    });

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
