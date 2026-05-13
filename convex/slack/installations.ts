import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
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
      .withIndex("by_teamId", (q) => q.eq("teamId", args.teamId))
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
    return await ctx.db.get(args.id);
  },
});

export const verifyInstallerStillAdmin = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    workosUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) =>
        q.eq("workosUserId", args.workosUserId),
      )
      .unique();

    if (!user) return null;
    if (user.tenantId !== args.tenantId) return null;
    if (user.isActive === false) return null;
    if (user.role !== "tenant_master" && user.role !== "tenant_admin") {
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
        throw new Error("Slack workspace already linked to another tenant");
      }
      await ctx.db.patch(existing._id, {
        ...row,
        lastRefreshedAt: undefined,
        refreshLockHolder: undefined,
        refreshLockAcquiredAt: undefined,
        uninstalledAt: undefined,
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
    const installation = await ctx.db.get(args.installationId);
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

    await ctx.db.patch(args.installationId, {
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
    const installation = await ctx.db.get(args.id);
    if (!installation) return;
    if (installation.refreshLockHolder !== args.lockHolder) return;

    await ctx.db.patch(args.id, {
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
    const installation = await ctx.db.get(args.id);
    if (!installation) {
      throw new Error("Installation gone during refresh");
    }
    if (installation.refreshLockHolder !== args.lockHolder) {
      throw new Error("Lock lost during refresh");
    }

    await ctx.db.patch(args.id, {
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
    await ctx.db.patch(args.id, {
      status: "token_expired",
      refreshLockHolder: undefined,
      refreshLockAcquiredAt: undefined,
    });
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

    await ctx.db.patch(row._id, {
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

    await ctx.db.patch(row._id, {
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
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
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
