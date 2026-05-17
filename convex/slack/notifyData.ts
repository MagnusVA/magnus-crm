import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { SOCIAL_PLATFORMS, type SocialPlatform } from "../lib/socialPlatform";
import { slackQualificationsByTime } from "../reporting/aggregates";
import {
  addBusinessDays,
  businessDateToUtcStart,
  timestampToBusinessDateKey,
} from "../reporting/lib/hondurasBusinessTime";

export const getOppForNotify = internalQuery({
  args: { opportunityId: v.id("opportunities") },
  handler: async (ctx, args) => {
    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity) return null;
    return {
      _id: opportunity._id,
      tenantId: opportunity.tenantId,
      qualifiedBy: opportunity.qualifiedBy,
    };
  },
});

export const getLeadForNotify = internalQuery({
  args: { leadId: v.id("leads") },
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) return null;
    return {
      _id: lead._id,
      fullName: lead.fullName,
      email: lead.email,
    };
  },
});

export const getPrimarySocialIdentifier = internalQuery({
  args: { leadId: v.id("leads") },
  handler: async (ctx, args) => {
    const identifiers = await ctx.db
      .query("leadIdentifiers")
      .withIndex("by_leadId", (q) => q.eq("leadId", args.leadId))
      .take(20);

    const primary = identifiers
      .filter((identifier) =>
        SOCIAL_PLATFORMS.includes(identifier.type as SocialPlatform),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];

    if (!primary) return null;
    return {
      platform: primary.type as SocialPlatform,
      rawValue: primary.rawValue,
    };
  },
});

export const getQualificationGoalProgress = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const tenant = await ctx.db.get(args.tenantId);
    const dailyTeamQualificationGoal =
      tenant?.slackQualificationDailyTeamQuota;

    if (
      dailyTeamQualificationGoal === undefined ||
      dailyTeamQualificationGoal <= 0
    ) {
      return null;
    }

    const businessDate = timestampToBusinessDateKey(args.now);
    const start = businessDateToUtcStart(businessDate);
    const end = businessDateToUtcStart(addBusinessDays(businessDate, 1));
    const qualifiedCount = await slackQualificationsByTime.count(ctx, {
      namespace: args.tenantId,
      bounds: {
        lower: { key: start, inclusive: true },
        upper: { key: end, inclusive: false },
      },
    });

    return {
      qualifiedCount,
      dailyTeamQualificationGoal,
    };
  },
});

export const recordNotifyFailure = internalMutation({
  args: {
    installationId: v.id("slackInstallations"),
    slackErr: v.string(),
    clearChannel: v.boolean(),
  },
  handler: async (ctx, args) => {
    const installation = await ctx.db.get(args.installationId);
    if (!installation) return;

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
