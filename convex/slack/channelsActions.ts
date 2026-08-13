import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireTenantUserFromAction } from "../requireTenantUserFromAction";
import { getValidSlackBotToken } from "./tokens";
import { slackApiGet } from "./webApi";

const CHANNEL_PAGE_LIMIT = 200;
const MAX_PAGES = 10;

export type SlackChannel = {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  isArchived: boolean;
};

type ConversationsListChannel = {
  id?: string;
  name?: string;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
};

export const disconnectSlack = action({
  args: {},
  returns: v.object({
    disconnected: v.boolean(),
    revokedInSlack: v.boolean(),
  }),
  handler: async (
    ctx,
  ): Promise<{ disconnected: boolean; revokedInSlack: boolean }> => {
    const { tenantId } = await requireTenantUserFromAction(ctx, [
      "tenant_master",
    ]);

    const installation = await ctx.runQuery(
      internal.slack.installations.byTenantId,
      { tenantId },
    );
    if (!installation || installation.status === "uninstalled") {
      return { disconnected: false, revokedInSlack: false };
    }

    // Best-effort remote revocation. auth.revoke invalidates the bot token on
    // Slack's side; removing the app from the workspace itself still requires
    // a Slack admin, hence the revokedInSlack flag for honest UI copy.
    let revokedInSlack = false;
    try {
      let token: string;
      try {
        token = await getValidSlackBotToken(ctx, tenantId);
      } catch {
        if (!installation.botAccessToken) {
          throw new Error("no usable bot token");
        }
        token = installation.botAccessToken;
      }
      const response = await slackApiGet<{ revoked?: boolean }>(
        "auth.revoke",
        token,
        {},
      );
      if (response.ok) {
        revokedInSlack = true;
      } else {
        console.warn("[Slack:Channels] auth.revoke failed", {
          tenantId,
          error: response.error ?? "unknown",
        });
      }
    } catch (error) {
      console.warn("[Slack:Channels] auth.revoke failed", {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const result: { disconnected: boolean } = await ctx.runMutation(
      internal.slack.installations.disconnectByTenant,
      { tenantId },
    );

    console.log("[Slack:Channels] disconnected", {
      tenantId,
      revokedInSlack,
    });

    return { disconnected: result.disconnected, revokedInSlack };
  },
});

export const listInstalledChannels = action({
  args: {},
  handler: async (ctx): Promise<SlackChannel[]> => {
    const access = await requireTenantUserFromAction(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const token = await getValidSlackBotToken(ctx, access.tenantId);
    const channels: SlackChannel[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await slackApiGet<{
        channels?: ConversationsListChannel[];
        response_metadata?: { next_cursor?: string };
      }>("conversations.list", token, {
        types: "public_channel,private_channel",
        limit: CHANNEL_PAGE_LIMIT,
        cursor,
        exclude_archived: false,
      });

      if (!response.ok) {
        throw new Error(
          `Slack conversations.list failed: ${response.error ?? "unknown"}`,
        );
      }

      for (const channel of response.channels ?? []) {
        if (!channel.id || !channel.name) continue;
        channels.push({
          id: channel.id,
          name: channel.name,
          isPrivate: Boolean(channel.is_private),
          isMember: Boolean(channel.is_member),
          isArchived: Boolean(channel.is_archived),
        });
      }

      cursor = response.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }

    channels.sort((a, b) => {
      if (a.isArchived !== b.isArchived) return a.isArchived ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    console.log("[Slack:Channels] listed", {
      tenantId: access.tenantId,
      count: channels.length,
    });

    return channels;
  },
});
