import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export type InstallationStatus =
  | { kind: "not_connected" }
  | {
      kind: "connected";
      status: "active" | "token_expired" | "revoked" | "uninstalled";
      teamId: string;
      teamName: string;
      installedAt: number;
      installedByWorkosUserId: string;
      notifyChannelId?: string;
      notifyChannelName?: string;
      staleReminderChannelId?: string;
      staleReminderChannelName?: string;
      notifyChannelError?: {
        code: string;
        channelId: string;
        channelName?: string;
        occurredAt: number;
      };
      staleReminderChannelError?: {
        code: string;
        channelId: string;
        channelName?: string;
        occurredAt: number;
      };
      lastRefreshedAt?: number;
    };

export const getInstallationStatus = query({
  args: {},
  handler: async (ctx): Promise<InstallationStatus> => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const installation = await ctx.db
      .query("slackInstallations")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();

    if (!installation) {
      return { kind: "not_connected" };
    }

    return {
      kind: "connected",
      status: installation.status,
      teamId: installation.teamId,
      teamName: installation.teamName,
      installedAt: installation.installedAt,
      installedByWorkosUserId: installation.installedByWorkosUserId,
      notifyChannelId: installation.notifyChannelId,
      notifyChannelName: installation.notifyChannelName,
      staleReminderChannelId: installation.staleReminderChannelId,
      staleReminderChannelName: installation.staleReminderChannelName,
      notifyChannelError: installation.notifyChannelError,
      staleReminderChannelError: installation.staleReminderChannelError,
      lastRefreshedAt: installation.lastRefreshedAt,
    };
  },
});

export const setSlackNotifyChannels = mutation({
  args: {
    notifyChannelId: v.string(),
    notifyChannelName: v.string(),
    staleReminderChannelId: v.string(),
    staleReminderChannelName: v.string(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const installation = await ctx.db
      .query("slackInstallations")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();

    if (!installation) {
      throw new Error("Slack not connected - finish OAuth first");
    }
    if (installation.status !== "active") {
      throw new Error(
        `Slack integration is ${installation.status} - reconnect first`,
      );
    }

    await ctx.db.patch(installation._id, {
      notifyChannelId: args.notifyChannelId,
      notifyChannelName: args.notifyChannelName,
      staleReminderChannelId: args.staleReminderChannelId,
      staleReminderChannelName: args.staleReminderChannelName,
      notifyChannelError: undefined,
      staleReminderChannelError: undefined,
    });

    console.log("[Slack:Channels] saved", {
      tenantId,
      notify: args.notifyChannelName,
      stale: args.staleReminderChannelName,
    });
  },
});

export const disconnectSlack = mutation({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master"]);

    const installation = await ctx.db
      .query("slackInstallations")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();
    if (!installation) return;

    await ctx.db.patch(installation._id, {
      status: "uninstalled",
      uninstalledAt: Date.now(),
      botAccessToken: "",
      refreshToken: "",
      refreshLockHolder: undefined,
      refreshLockAcquiredAt: undefined,
    });

    console.log("[Slack:Channels] disconnected", {
      tenantId,
      installationId: installation._id,
    });
  },
});
