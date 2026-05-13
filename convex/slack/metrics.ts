import { v } from "convex/values";
import { query, type QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  isSocialPlatform,
  SOCIAL_PLATFORM_LABELS,
  SOCIAL_PLATFORMS,
  type SocialPlatform,
} from "../lib/socialPlatform";
import { requireTenantUser } from "../requireTenantUser";

const ROW_CAP = 1000;

export const conversionMetrics = query({
  args: {
    windowStart: v.number(),
    windowEnd: v.number(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const opportunities = await getSlackQualifiedOpportunities(ctx, {
      tenantId,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
    });

    const total = opportunities.rows.length;
    const booked = opportunities.rows.filter(
      (opportunity) => opportunity.latestMeetingId !== undefined,
    ).length;
    const lost = opportunities.rows.filter(
      (opportunity) => opportunity.status === "lost",
    ).length;
    const stillPending = opportunities.rows.filter(
      (opportunity) => opportunity.status === "qualified_pending",
    ).length;

    return {
      total,
      booked,
      lost,
      stillPending,
      ratio: total === 0 ? null : booked / total,
      truncated: opportunities.truncated,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
    };
  },
});

export const perSlackUserBreakdown = query({
  args: {
    windowStart: v.number(),
    windowEnd: v.number(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const opportunities = await getSlackQualifiedOpportunities(ctx, {
      tenantId,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
    });

    const counts = new Map<string, { total: number; booked: number }>();
    for (const opportunity of opportunities.rows) {
      const slackUserId = opportunity.qualifiedBy?.slackUserId;
      if (!slackUserId) continue;

      const current = counts.get(slackUserId) ?? { total: 0, booked: 0 };
      current.total += 1;
      if (opportunity.latestMeetingId !== undefined) {
        current.booked += 1;
      }
      counts.set(slackUserId, current);
    }

    const rows = [];
    for (const [slackUserId, count] of counts) {
      const user = await ctx.db
        .query("slackUsers")
        .withIndex("by_tenantId_and_slackUserId", (q) =>
          q.eq("tenantId", tenantId).eq("slackUserId", slackUserId),
        )
        .unique();

      rows.push({
        slackUserId,
        displayName:
          user?.displayName ?? user?.realName ?? user?.username ?? null,
        avatarUrl: user?.avatarUrl ?? null,
        isDeleted: user?.isDeleted ?? false,
        total: count.total,
        booked: count.booked,
        ratio: count.total === 0 ? null : count.booked / count.total,
      });
    }

    rows.sort((a, b) => b.total - a.total || b.booked - a.booked);

    return {
      rows: rows.slice(0, 25),
      truncated: opportunities.truncated,
    };
  },
});

export const perPlatformConversion = query({
  args: {
    windowStart: v.number(),
    windowEnd: v.number(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const opportunities = await getSlackQualifiedOpportunities(ctx, {
      tenantId,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
    });
    const platformCounts = Object.fromEntries(
      SOCIAL_PLATFORMS.map((platform) => [
        platform,
        { total: 0, booked: 0 },
      ]),
    ) as Record<SocialPlatform, { total: number; booked: number }>;

    for (const opportunity of opportunities.rows) {
      const identifiers = await ctx.db
        .query("leadIdentifiers")
        .withIndex("by_leadId", (q) => q.eq("leadId", opportunity.leadId))
        .take(10);
      const primary = identifiers
        .filter((identifier) => isSocialPlatform(identifier.type))
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!primary || !isSocialPlatform(primary.type)) continue;

      platformCounts[primary.type].total += 1;
      if (opportunity.latestMeetingId !== undefined) {
        platformCounts[primary.type].booked += 1;
      }
    }

    return {
      rows: SOCIAL_PLATFORMS.map((platform) => {
        const count = platformCounts[platform];
        return {
          platform,
          label: SOCIAL_PLATFORM_LABELS[platform],
          total: count.total,
          booked: count.booked,
          ratio: count.total === 0 ? null : count.booked / count.total,
        };
      })
        .filter((row) => row.total > 0)
        .sort((a, b) => b.total - a.total || b.booked - a.booked),
      truncated: opportunities.truncated,
    };
  },
});

async function getSlackQualifiedOpportunities(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    windowStart: number;
    windowEnd: number;
  },
) {
  const rows = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_source_and_createdAt", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("source", "slack_qualified")
        .gte("createdAt", args.windowStart)
        .lt("createdAt", args.windowEnd),
    )
    .take(ROW_CAP + 1);

  return {
    rows: rows.slice(0, ROW_CAP),
    truncated: rows.length > ROW_CAP,
  };
}
