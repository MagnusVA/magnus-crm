import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { describeError, log, reportError } from "../lib/observability/log";
import { normalizeSlackUserProfile } from "./profileNames";
import { getValidSlackBotToken, logSlackTokenUnavailable } from "./tokens";
import { slackApiGet } from "./webApi";

type SlackUserInfo = {
  name?: string;
  real_name?: string;
  profile?: {
    display_name?: string;
    display_name_normalized?: string;
    real_name?: string;
    real_name_normalized?: string;
    image_72?: string;
  };
  tz?: string;
  is_bot?: boolean;
  deleted?: boolean;
};

export const fetchAndSync = internalAction({
  args: { slackUserRowId: v.id("slackUsers") },
  handler: async (ctx, args) => {
    const row = await ctx.runQuery(internal.slack.users._byId, {
      id: args.slackUserRowId,
    });
    if (!row) return;

    const enrichAttrs = {
      tenantId: row.tenantId,
      slackUserRowId: args.slackUserRowId,
    };

    let token: string;
    try {
      token = await getValidSlackBotToken(ctx, row.tenantId);
    } catch (error) {
      logSlackTokenUnavailable(
        "slack.users.enrich_token_unavailable",
        error,
        enrichAttrs,
      );
      return;
    }

    try {
      const response = await slackApiGet<{
        user: SlackUserInfo;
      }>("users.info", token, { user: row.slackUserId });
      if (!response.ok) {
        const slackError = response.error ?? "unknown";
        reportError(
          "slack.users.enrich_failed",
          new Error(`Slack users.info failed: ${slackError}`),
          {
            severity: "warning",
            integration: "slack",
            fingerprint: `slack.users.enrich_failed:${slackError}`,
            slackError,
            ...enrichAttrs,
          },
        );
        return;
      }

      const user = response.user;
      const profile = normalizeSlackUserProfile(user);

      await ctx.runMutation(internal.slack.users.applyProfile, {
        id: args.slackUserRowId,
        username: profile.username,
        realName: profile.realName,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        timezone: profile.timezone,
        isBot: Boolean(user.is_bot),
        isDeleted: Boolean(user.deleted),
        syncedAt: Date.now(),
      });
      log.info("slack.users.enriched", {
        ...enrichAttrs,
        isBot: Boolean(user.is_bot),
        isDeleted: Boolean(user.deleted),
      });
    } catch (error) {
      const errorName = describeError(error).name;
      reportError(
        "slack.users.enrich_failed",
        new Error("Slack user profile enrichment failed"),
        {
          severity: "warning",
          integration: "slack",
          fingerprint: `slack.users.enrich_failed:${errorName}`,
          errorName,
          ...enrichAttrs,
        },
      );
    }
  },
});
