import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { SOCIAL_PLATFORMS, type SocialPlatform } from "../lib/socialPlatform";

export const listActiveInstallationIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("slackInstallations")
      .withIndex("by_status_and_tokenExpiresAt", (q) =>
        q.eq("status", "active"),
      )
      .take(1000);

    return rows.map((row) => row._id);
  },
});

export const listStaleOpportunities = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    cutoff: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const opportunities = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_source_and_status_and_createdAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("source", "slack_qualified")
          .eq("status", "qualified_pending")
          .lt("createdAt", args.cutoff),
      )
      .order("asc")
      .take(args.limit + 1);

    const hasMore = opportunities.length > args.limit;
    const entries = [];

    for (const opportunity of opportunities.slice(0, args.limit)) {
      const lead = await ctx.db.get(opportunity.leadId);
      if (!lead) continue;

      const identifiers = await ctx.db
        .query("leadIdentifiers")
        .withIndex("by_leadId", (q) => q.eq("leadId", opportunity.leadId))
        .take(10);

      const primary = identifiers
        .filter((identifier) =>
          SOCIAL_PLATFORMS.includes(identifier.type as SocialPlatform),
        )
        .sort((a, b) => b.createdAt - a.createdAt)[0];

      if (!primary || !opportunity.qualifiedBy) continue;

      entries.push({
        opportunityId: opportunity._id,
        createdAt: opportunity.createdAt,
        leadFullName: lead.fullName ?? null,
        leadEmail: lead.email ?? null,
        platform: primary.type as SocialPlatform,
        handle: primary.rawValue,
        qualifiedBySlackUserId: opportunity.qualifiedBy.slackUserId,
      });
    }

    return { opps: entries, hasMore };
  },
});

export const recordChannelFailure = internalMutation({
  args: {
    installationId: v.id("slackInstallations"),
    channelKind: v.union(v.literal("notify"), v.literal("staleReminder")),
    slackErr: v.string(),
    clearChannel: v.boolean(),
  },
  handler: async (ctx, args) => {
    const installation = await ctx.db.get(args.installationId);
    if (!installation) return;

    if (args.channelKind === "staleReminder") {
      await ctx.db.patch(args.installationId, {
        staleReminderChannelId: args.clearChannel
          ? undefined
          : installation.staleReminderChannelId,
        staleReminderChannelName: args.clearChannel
          ? undefined
          : installation.staleReminderChannelName,
        staleReminderChannelError: {
          code: args.slackErr,
          channelId: installation.staleReminderChannelId ?? "unknown",
          channelName: installation.staleReminderChannelName,
          occurredAt: Date.now(),
        },
      });
      return;
    }

    await ctx.db.patch(args.installationId, {
      notifyChannelId: args.clearChannel
        ? undefined
        : installation.notifyChannelId,
      notifyChannelName: args.clearChannel
        ? undefined
        : installation.notifyChannelName,
      notifyChannelError: {
        code: args.slackErr,
        channelId: installation.notifyChannelId ?? "unknown",
        channelName: installation.notifyChannelName,
        occurredAt: Date.now(),
      },
    });
  },
});
