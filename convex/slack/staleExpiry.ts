import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery } from "../_generated/server";
import { log } from "../lib/observability/log";
import { transitionOpportunity } from "../lib/opportunityActivity";
import { SLACK_JOIN_LOOKBACK_MS } from "../pipeline/slackJoinLookup";

const DAY_MS = 24 * 60 * 60 * 1000;

// A booking can join a Slack-qualified opportunity for 30 days. After that a
// booking opens a new opportunity, so the old one would stay open forever.
// It closes one day after the window, so the 8am stale digest
// (staleReminders.ts) lists it exactly once first.
export const SLACK_OPPORTUNITY_EXPIRY_MS = SLACK_JOIN_LOOKBACK_MS + DAY_MS;

export const STALE_LOST_REASON = "stale";

// Each transition rebuilds the lead's search row, so keep batches small.
const EXPIRY_BATCH_SIZE = 20;
const PREVIEW_LIMIT = 1000;

/**
 * Closes Slack-qualified opportunities that never booked as lost, reason
 * "stale". Runs hourly across tenants and schedules itself until the backlog
 * is empty.
 */
export const expireStaleSlackOpportunities = internalMutation({
  args: {},
  returns: v.object({ expired: v.number(), hasMore: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("opportunities")
      .withIndex("by_source_and_status_and_createdAt", (q) =>
        q
          .eq("source", "slack_qualified")
          .eq("status", "qualified_pending")
          .lt("createdAt", now - SLACK_OPPORTUNITY_EXPIRY_MS),
      )
      .take(EXPIRY_BATCH_SIZE + 1);
    const batch = stale.slice(0, EXPIRY_BATCH_SIZE);

    for (const opportunity of batch) {
      await transitionOpportunity(ctx, opportunity._id, {
        to: "lost",
        fields: { lostAt: now, lostReason: STALE_LOST_REASON, updatedAt: now },
        source: "system",
        eventType: "opportunity.marked_lost",
        reason: STALE_LOST_REASON,
        metadata: { trigger: "slack_join_window_expired" },
        occurredAt: now,
      });
    }

    const hasMore = stale.length > EXPIRY_BATCH_SIZE;
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.slack.staleExpiry.expireStaleSlackOpportunities,
        {},
      );
    }
    if (batch.length > 0) {
      log.info("slack.stale_opportunities.expired", {
        expired: batch.length,
        hasMore,
      });
    }
    return { expired: batch.length, hasMore };
  },
});

/** Read-only count of what the next expiry run would close, across tenants. */
export const previewStaleSlackOpportunities = internalQuery({
  args: {},
  returns: v.object({
    count: v.number(),
    capped: v.boolean(),
    oldestCreatedAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx) => {
    const stale = await ctx.db
      .query("opportunities")
      .withIndex("by_source_and_status_and_createdAt", (q) =>
        q
          .eq("source", "slack_qualified")
          .eq("status", "qualified_pending")
          .lt("createdAt", Date.now() - SLACK_OPPORTUNITY_EXPIRY_MS),
      )
      .take(PREVIEW_LIMIT + 1);
    return {
      count: Math.min(stale.length, PREVIEW_LIMIT),
      capped: stale.length > PREVIEW_LIMIT,
      oldestCreatedAt: stale[0]?.createdAt ?? null,
    };
  },
});
