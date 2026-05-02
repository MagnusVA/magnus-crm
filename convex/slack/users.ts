import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../_generated/server";
import {
  hasSlackDisplayName,
  normalizeSlackUserProfile,
} from "./profileNames";

const STALE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

type UpsertOnSubmissionArgs = {
  tenantId: Id<"tenants">;
  installationId: Id<"slackInstallations">;
  slackUserId: string;
  slackTeamId: string;
  now: number;
};

export const byTenantAndSlackUserId = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    slackUserId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("slackUsers")
      .withIndex("by_tenantId_and_slackUserId", (q) =>
        q.eq("tenantId", args.tenantId).eq("slackUserId", args.slackUserId),
      )
      .unique();
  },
});

export async function upsertSlackUserOnSubmission(
  ctx: MutationCtx,
  args: UpsertOnSubmissionArgs,
): Promise<Id<"slackUsers">> {
  const existing = await ctx.db
    .query("slackUsers")
    .withIndex("by_tenantId_and_slackUserId", (q) =>
      q.eq("tenantId", args.tenantId).eq("slackUserId", args.slackUserId),
    )
    .unique();

  if (!existing) {
    const id = await ctx.db.insert("slackUsers", {
      tenantId: args.tenantId,
      installationId: args.installationId,
      slackUserId: args.slackUserId,
      slackTeamId: args.slackTeamId,
      isBot: false,
      isDeleted: false,
      firstSeenAt: args.now,
      lastSeenAt: args.now,
      lastSyncedAt: 0,
    });

    await ctx.scheduler.runAfter(0, internal.slack.userActions.fetchAndSync, {
      slackUserRowId: id,
    });
    console.log("[Slack:Users] stub inserted", {
      tenantId: args.tenantId,
      slackUserId: args.slackUserId,
    });
    return id;
  }

  await ctx.db.patch(existing._id, {
    lastSeenAt: args.now,
    installationId: args.installationId,
    slackTeamId: args.slackTeamId,
  });

  if (
    !hasSlackDisplayName(existing.displayName) ||
    args.now - existing.lastSyncedAt > STALE_REFRESH_MS
  ) {
    await ctx.scheduler.runAfter(0, internal.slack.userActions.fetchAndSync, {
      slackUserRowId: existing._id,
    });
  }

  return existing._id;
}

export const upsertOnSubmission = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    installationId: v.id("slackInstallations"),
    slackUserId: v.string(),
    slackTeamId: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    return await upsertSlackUserOnSubmission(ctx, args);
  },
});

export const applyProfile = internalMutation({
  args: {
    id: v.id("slackUsers"),
    username: v.optional(v.string()),
    realName: v.optional(v.string()),
    displayName: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    timezone: v.optional(v.string()),
    isBot: v.boolean(),
    isDeleted: v.boolean(),
    syncedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) return;

    const patch: {
      username?: string;
      realName?: string;
      displayName?: string;
      avatarUrl?: string;
      timezone?: string;
      isBot: boolean;
      isDeleted: boolean;
      lastSyncedAt: number;
    } = {
      isBot: args.isBot,
      isDeleted: args.isDeleted,
      lastSyncedAt: args.syncedAt,
    };
    const username = args.username ?? row.username;
    const realName = args.realName ?? row.realName;
    const displayName = args.displayName ?? row.displayName;
    const avatarUrl = args.avatarUrl ?? row.avatarUrl;
    const timezone = args.timezone ?? row.timezone;
    if (username !== undefined) patch.username = username;
    if (realName !== undefined) patch.realName = realName;
    if (displayName !== undefined) patch.displayName = displayName;
    if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl;
    if (timezone !== undefined) patch.timezone = timezone;

    await ctx.db.patch(args.id, patch);
  },
});

export const handleUserChange = internalMutation({
  args: {
    installationId: v.id("slackInstallations"),
    userPayload: v.any(),
  },
  handler: async (ctx, args) => {
    const user = args.userPayload as {
      id?: string;
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
    const slackUserId = user.id;
    if (!slackUserId) return;

    const row = await ctx.db
      .query("slackUsers")
      .withIndex("by_installationId_and_slackUserId", (q) =>
        q.eq("installationId", args.installationId).eq("slackUserId", slackUserId),
      )
      .unique();
    if (!row) return;

    const profile = normalizeSlackUserProfile(user);

    const patch: {
      username?: string;
      realName?: string;
      displayName?: string;
      avatarUrl?: string;
      timezone?: string;
      isBot: boolean;
      isDeleted: boolean;
      lastSyncedAt: number;
    } = {
      isBot: Boolean(user.is_bot),
      isDeleted: Boolean(user.deleted),
      lastSyncedAt: Date.now(),
    };
    const username = profile.username ?? row.username;
    const realName = profile.realName ?? row.realName;
    const displayName = profile.displayName ?? row.displayName;
    const avatarUrl = profile.avatarUrl ?? row.avatarUrl;
    const timezone = profile.timezone ?? row.timezone;
    if (username !== undefined) patch.username = username;
    if (realName !== undefined) patch.realName = realName;
    if (displayName !== undefined) patch.displayName = displayName;
    if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl;
    if (timezone !== undefined) patch.timezone = timezone;

    await ctx.db.patch(row._id, patch);
    console.log("[Slack:Users] user_change applied", {
      installationId: args.installationId,
      slackUserId,
    });
  },
});

export const _byId = internalQuery({
  args: { id: v.id("slackUsers") },
  handler: async (ctx, args): Promise<Doc<"slackUsers"> | null> => {
    return await ctx.db.get(args.id);
  },
});
