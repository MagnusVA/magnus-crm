import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { normalizeSlackUserProfile } from "./profileNames";
import { getValidSlackBotToken } from "./tokens";
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

    let token: string;
    try {
      token = await getValidSlackBotToken(ctx, row.tenantId);
    } catch (error) {
      console.warn("[Slack:Users] enrich token unavailable", {
        slackUserRowId: args.slackUserRowId,
        err: error instanceof Error ? error.message : "unknown",
      });
      return;
    }

    try {
      const response = await slackApiGet<{
        user: SlackUserInfo;
      }>("users.info", token, { user: row.slackUserId });
      if (!response.ok) {
        console.warn("[Slack:Users] users.info returned !ok", {
          slackUserRowId: args.slackUserRowId,
          error: response.error ?? "unknown",
        });
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
      console.log("[Slack:Users] enriched", {
        slackUserRowId: args.slackUserRowId,
      });
    } catch (error) {
      console.error("[Slack:Users] users.info threw", {
        slackUserRowId: args.slackUserRowId,
        err: error instanceof Error ? error.message : "unknown",
      });
    }
  },
});
