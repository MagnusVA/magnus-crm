import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { rejectRequest } from "../lib/observability/errors";
import { describeError, log, reportError } from "../lib/observability/log";
import { requireTenantUserFromAction } from "../requireTenantUserFromAction";
import {
  getValidSlackBotToken,
  SlackInstallationMissingError,
  SlackInstallationNotActiveError,
  slackTokenUnavailableReason,
  type SlackTokenUnavailableReason,
} from "./tokens";
import { slackApiGet } from "./webApi";

const CHANNEL_PAGE_LIMIT = 200;
const MAX_PAGES = 10;

/**
 * auth.revoke errors meaning the token is already dead (the app was removed
 * or the token revoked in Slack), so there's nothing left to revoke.
 */
const ALREADY_REVOKED_ERRORS = new Set([
  "token_revoked",
  "invalid_auth",
  "account_inactive",
]);

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
    const revokeAttrs = { tenantId, installationId: installation._id };
    try {
      let token: string | undefined;
      let tokenFailure: SlackTokenUnavailableReason | undefined;
      try {
        token = await getValidSlackBotToken(ctx, tenantId);
      } catch (error) {
        // `token_expired` was already reported as `slack.token.expired`.
        tokenFailure = slackTokenUnavailableReason(error);
        token = installation.botAccessToken || undefined;
      }

      if (!token) {
        log.info("slack.disconnect.revoke_skipped", {
          ...revokeAttrs,
          reason: "no_usable_token",
          tokenFailure,
        });
      } else {
        const response = await slackApiGet<{ revoked?: boolean }>(
          "auth.revoke",
          token,
          {},
        );
        if (response.ok) {
          revokedInSlack = true;
        } else {
          const slackError = response.error ?? "unknown";
          if (
            ALREADY_REVOKED_ERRORS.has(slackError) ||
            tokenFailure === "token_expired"
          ) {
            log.info("slack.disconnect.revoke_skipped", {
              ...revokeAttrs,
              reason: "token_already_invalid",
              slackError,
              tokenFailure,
            });
          } else {
            reportError(
              "slack.disconnect.revoke_failed",
              new Error(`Slack auth.revoke failed: ${slackError}`),
              {
                severity: "warning",
                integration: "slack",
                fingerprint: `slack.disconnect.revoke_failed:${slackError}`,
                ...revokeAttrs,
                slackError,
                tokenFailure,
              },
            );
          }
        }
      }
    } catch (error) {
      const errorName = describeError(error).name;
      reportError(
        "slack.disconnect.revoke_failed",
        new Error("Slack auth.revoke request failed"),
        {
          severity: "warning",
          integration: "slack",
          fingerprint: `slack.disconnect.revoke_failed:${errorName}`,
          errorName,
          ...revokeAttrs,
        },
      );
    }

    const result: { disconnected: boolean } = await ctx.runMutation(
      internal.slack.installations.disconnectByTenant,
      { tenantId },
    );

    log.info("slack.disconnect.completed", {
      tenantId,
      installationId: installation._id,
      disconnected: result.disconnected,
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

    let token: string;
    try {
      token = await getValidSlackBotToken(ctx, access.tenantId);
    } catch (error) {
      if (
        error instanceof SlackInstallationMissingError ||
        error instanceof SlackInstallationNotActiveError
      ) {
        throw rejectRequest(
          "slack.not_connected",
          "Slack is not connected for this workspace.",
          {
            tenantId: access.tenantId,
            reason: slackTokenUnavailableReason(error),
          },
        );
      }
      throw error;
    }
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

    return channels;
  },
});
