import { action } from "../_generated/server";
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
