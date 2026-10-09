import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { log } from "../lib/observability/log";
import { requireTenantUser } from "../requireTenantUser";

const STALE_LOCK_MS = 30_000;

type SlackConnectionStatus = {
  tenantId: Id<"tenants">;
  installationId: Id<"slackInstallations"> | null;
  status:
    | "not_installed"
    | "active"
    | "token_expired"
    | "revoked"
    | "uninstalled";
  needsReconnect: boolean;
  needsChannelConfig: boolean;
  teamName: string | null;
  appId: string | null;
  botUserId: string | null;
  installedAt: number | null;
  lastRefreshedAt: number | null;
  tokenExpiresAt: number | null;
  notifyChannelName: string | null;
  staleReminderChannelName: string | null;
};

export const getConnectionStatus = query({
  args: {},
  handler: async (ctx): Promise<SlackConnectionStatus> => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const installation = await ctx.db
      .query("slackInstallations")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();

    if (!installation) {
      return {
        tenantId,
        installationId: null,
        status: "not_installed",
        needsReconnect: false,
        needsChannelConfig: false,
        teamName: null,
        appId: null,
        botUserId: null,
        installedAt: null,
        lastRefreshedAt: null,
        tokenExpiresAt: null,
        notifyChannelName: null,
        staleReminderChannelName: null,
      };
    }

    const needsReconnect = installation.status !== "active";
    const needsChannelConfig =
      installation.status === "active" &&
      (!installation.notifyChannelId || !installation.staleReminderChannelId);

    return {
      tenantId,
      installationId: installation._id,
      status: installation.status,
      needsReconnect,
      needsChannelConfig,
      teamName: installation.teamName,
      appId: installation.appId,
      botUserId: installation.botUserId,
      installedAt: installation.installedAt,
      lastRefreshedAt: installation.lastRefreshedAt ?? null,
      tokenExpiresAt: installation.tokenExpiresAt,
      notifyChannelName: installation.notifyChannelName ?? null,
      staleReminderChannelName: installation.staleReminderChannelName ?? null,
    };
  },
});

export const byTeamIdAndAppId = internalQuery({
  args: {
    teamId: v.string(),
    appId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("slackInstallations")
      .withIndex("by_teamId_and_appId", (q) =>
        q.eq("teamId", args.teamId).eq("appId", args.appId),
      )
      .unique();
  },
});

export const byTeamId = internalQuery({
  args: { teamId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("slackInstallations")
      .withIndex("by_teamId_and_appId", (q) => q.eq("teamId", args.teamId))
      .take(10);
  },
});

export const byTenantId = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("slackInstallations")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
      .first();
  },
});

export const byId = internalQuery({
  args: { id: v.id("slackInstallations") },
  handler: async (ctx, args) => {
    return await ctx.db.get("slackInstallations", args.id);
  },
});

export const verifyInstallerStillAdmin = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    workosUserId: v.string(),
    requestId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) =>
        q.eq("workosUserId", args.workosUserId),
      )
      .unique();

    if (!user) {
      log.warn("slack.oauth.installer_rejected", {
        reason: "user_missing",
        requestId: args.requestId,
        tenantId: args.tenantId,
      });
      return null;
    }
    if (user.tenantId !== args.tenantId) {
      log.warn("slack.oauth.installer_rejected", {
        reason: "tenant_mismatch",
        requestId: args.requestId,
        expectedTenantId: args.tenantId,
        actualTenantId: user.tenantId,
        userId: user._id,
      });
      return null;
    }
    if (user.isActive === false) {
      log.warn("slack.oauth.installer_rejected", {
        reason: "user_inactive",
        requestId: args.requestId,
        tenantId: args.tenantId,
        userId: user._id,
      });
      return null;
    }
    if (user.role !== "tenant_master" && user.role !== "tenant_admin") {
      log.warn("slack.oauth.installer_rejected", {
        reason: "role_not_admin",
        requestId: args.requestId,
        tenantId: args.tenantId,
        userId: user._id,
        role: user.role,
      });
      return null;
    }

    return { userId: user._id };
  },
});

export const upsertOnInstall = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    teamId: v.string(),
    teamName: v.string(),
    enterpriseId: v.optional(v.string()),
    isEnterpriseInstall: v.boolean(),
    appId: v.string(),
    botUserId: v.string(),
    botAccessToken: v.string(),
    refreshToken: v.string(),
    tokenExpiresAt: v.number(),
    scopes: v.array(v.string()),
    installedByWorkosUserId: v.string(),
    requestId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("slackInstallations")
      .withIndex("by_teamId_and_appId", (q) =>
        q.eq("teamId", args.teamId).eq("appId", args.appId),
      )
      .unique();

    const now = Date.now();
    const row = {
      tenantId: args.tenantId,
      teamId: args.teamId,
      teamName: args.teamName,
      ...(args.enterpriseId ? { enterpriseId: args.enterpriseId } : {}),
      isEnterpriseInstall: args.isEnterpriseInstall,
      appId: args.appId,
      botUserId: args.botUserId,
      botAccessToken: args.botAccessToken,
      scopes: args.scopes,
      installedByWorkosUserId: args.installedByWorkosUserId,
      installedAt: now,
      tokenExpiresAt: args.tokenExpiresAt,
      refreshToken: args.refreshToken,
      status: "active" as const,
    };

    if (existing) {
      if (existing.tenantId !== args.tenantId) {
        log.warn("slack.installation.rejected", {
          reason: "tenant_mismatch",
          requestId: args.requestId,
          installationId: existing._id,
          existingTenantId: existing.tenantId,
          attemptingTenantId: args.tenantId,
          teamId: args.teamId,
          appId: args.appId,
        });
        throw new Error("Slack workspace already linked to another tenant");
      }
      await ctx.db.patch("slackInstallations", existing._id, {
        ...row,
        lastRefreshedAt: undefined,
        refreshLockHolder: undefined,
        refreshLockAcquiredAt: undefined,
        uninstalledAt: undefined,
      });
      log.info("slack.installation.upsert_fallback", {
        reason: "existing_row_patched",
        requestId: args.requestId,
        installationId: existing._id,
        tenantId: args.tenantId,
        previousStatus: existing.status,
      });
      return existing._id;
    }

    return await ctx.db.insert("slackInstallations", row);
  },
});

export const tryAcquireRefreshLock = internalMutation({
  args: {
    installationId: v.id("slackInstallations"),
    lockHolder: v.string(),
    staleAfterMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const installation = await ctx.db.get("slackInstallations", args.installationId);
    if (!installation) {
      return false;
    }

    const now = Date.now();
    const staleAfterMs = args.staleAfterMs ?? STALE_LOCK_MS;
    const lockIsFresh =
      Boolean(installation.refreshLockHolder) &&
      Boolean(installation.refreshLockAcquiredAt) &&
      now - (installation.refreshLockAcquiredAt ?? 0) < staleAfterMs;

    if (
      lockIsFresh &&
      installation.refreshLockHolder !== args.lockHolder
    ) {
      return false;
    }

    await ctx.db.patch("slackInstallations", args.installationId, {
      refreshLockHolder: args.lockHolder,
      refreshLockAcquiredAt: now,
    });
    return true;
  },
});

export const releaseRefreshLock = internalMutation({
  args: {
    id: v.id("slackInstallations"),
    lockHolder: v.string(),
  },
  handler: async (ctx, args) => {
    const installation = await ctx.db.get("slackInstallations", args.id);
    if (!installation) return;
    if (installation.refreshLockHolder !== args.lockHolder) return;

    await ctx.db.patch("slackInstallations", args.id, {
      refreshLockHolder: undefined,
      refreshLockAcquiredAt: undefined,
    });
  },
});

export const completeRefresh = internalMutation({
  args: {
    id: v.id("slackInstallations"),
    lockHolder: v.string(),
    botAccessToken: v.string(),
    refreshToken: v.string(),
    tokenExpiresAt: v.number(),
    lastRefreshedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const installation = await ctx.db.get("slackInstallations", args.id);
    if (!installation) {
      throw new Error("Installation gone during refresh");
    }
    if (installation.refreshLockHolder !== args.lockHolder) {
      throw new Error("Lock lost during refresh");
    }

    await ctx.db.patch("slackInstallations", args.id, {
      botAccessToken: args.botAccessToken,
      refreshToken: args.refreshToken,
      tokenExpiresAt: args.tokenExpiresAt,
      lastRefreshedAt: args.lastRefreshedAt,
      refreshLockHolder: undefined,
      refreshLockAcquiredAt: undefined,
      status: "active",
    });
  },
});

export const markTokenExpired = internalMutation({
  args: { id: v.id("slackInstallations") },
  handler: async (ctx, args) => {
    await ctx.db.patch("slackInstallations", args.id, {
      status: "token_expired",
      refreshLockHolder: undefined,
      refreshLockAcquiredAt: undefined,
    });
  },
});

export const disconnectByTenant = internalMutation({
  args: { tenantId: v.id("tenants") },
  returns: v.object({ disconnected: v.boolean() }),
  handler: async (ctx, args) => {
    const installation = await ctx.db
      .query("slackInstallations")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
      .first();
    if (!installation || installation.status === "uninstalled") {
      return { disconnected: false };
    }

    await ctx.db.patch("slackInstallations", installation._id, {
      status: "uninstalled",
      uninstalledAt: Date.now(),
      botAccessToken: "",
      refreshToken: "",
      refreshLockHolder: undefined,
      refreshLockAcquiredAt: undefined,
    });

    return { disconnected: true };
  },
});

export const markUninstalled = internalMutation({
  args: {
    teamId: v.string(),
    appId: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("slackInstallations")
      .withIndex("by_teamId_and_appId", (q) =>
        q.eq("teamId", args.teamId).eq("appId", args.appId),
      )
      .unique();
    if (!row || row.status === "uninstalled") {
      return [];
    }

    await ctx.db.patch("slackInstallations", row._id, {
      status: "uninstalled",
      uninstalledAt: Date.now(),
      botAccessToken: "",
      refreshToken: "",
      refreshLockHolder: undefined,
      refreshLockAcquiredAt: undefined,
    });

    return [
      {
        tenantId: row.tenantId,
        installationId: row._id,
        previousStatus: row.status,
      },
    ];
  },
});

export const markRevoked = internalMutation({
  args: {
    teamId: v.string(),
    appId: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("slackInstallations")
      .withIndex("by_teamId_and_appId", (q) =>
        q.eq("teamId", args.teamId).eq("appId", args.appId),
      )
      .unique();
    if (!row || row.status === "uninstalled" || row.status === "revoked") {
      return [];
    }

    await ctx.db.patch("slackInstallations", row._id, {
      status: "revoked",
      uninstalledAt: Date.now(),
      botAccessToken: "",
      refreshToken: "",
      refreshLockHolder: undefined,
      refreshLockAcquiredAt: undefined,
    });

    return [
      {
        tenantId: row.tenantId,
        installationId: row._id,
        previousStatus: row.status,
      },
    ];
  },
});

export const reactivate = internalMutation({
  args: {
    id: v.id("slackInstallations"),
    teamName: v.string(),
    enterpriseId: v.optional(v.string()),
    isEnterpriseInstall: v.boolean(),
    appId: v.string(),
    botUserId: v.string(),
    botAccessToken: v.string(),
    refreshToken: v.string(),
    tokenExpiresAt: v.number(),
    scopes: v.array(v.string()),
    installedByWorkosUserId: v.string(),
    requestId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get("slackInstallations", args.id);
    if (!existing) {
      log.warn("slack.installation.rejected", {
        reason: "installation_missing",
        requestId: args.requestId,
        installationId: args.id,
      });
      throw new Error("Slack installation missing during reactivation");
    }

    await ctx.db.patch("slackInstallations", args.id, {
      teamName: args.teamName,
      enterpriseId: args.enterpriseId,
      isEnterpriseInstall: args.isEnterpriseInstall,
      appId: args.appId,
      botUserId: args.botUserId,
      botAccessToken: args.botAccessToken,
      refreshToken: args.refreshToken,
      tokenExpiresAt: args.tokenExpiresAt,
      scopes: args.scopes,
      installedByWorkosUserId: args.installedByWorkosUserId,
      installedAt: Date.now(),
      lastRefreshedAt: undefined,
      refreshLockHolder: undefined,
      refreshLockAcquiredAt: undefined,
      status: "active",
      uninstalledAt: undefined,
    });
  },
});
