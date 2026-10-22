import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../_generated/server";
import { recordSlackDealExpired } from "../lib/leadLifecycle";
import { log } from "../lib/observability/log";
import {
  computeLatestActivityAt,
  transitionOpportunity,
} from "../lib/opportunityActivity";
import { isQualifiedSlackDeal } from "../opportunities/dealGuards";
import {
  SLACK_OPPORTUNITY_EXPIRY_MS,
  SLACK_STALE_LOST_REASON,
} from "../pipeline/slackJoinLookup";

// A booking can join a Slack-qualified opportunity for 30 days. After that it
// opens a new opportunity, so one that never booked would stay open for good.
// These close as lost, reason "stale", a day after the join window. They are
// the Slack deals still at Qualified, read on the stage index
// (docs/plans/phase-5-deal-status.md §6.8); Qualified allows only open.

/**
 * Opportunities that passed the expiry before this moment are the backlog at
 * rollout. The hourly cron leaves them alone, so its first run changes no old
 * data; `migrations:expireStaleSlackBacklog` closes them once the owner has
 * checked the count with `previewStaleSlackOpportunities`.
 */
export const STALE_EXPIRY_CUTOVER_AT = Date.parse("2026-10-16T00:00:00Z");

const SCAN_PAGE_SIZE = 50;
const PREVIEW_LIMIT = 1000;

function isStillStale(
  opportunity: Doc<"opportunities"> | null,
  now: number,
): opportunity is Doc<"opportunities"> {
  return (
    opportunity !== null &&
    isQualifiedSlackDeal(opportunity) &&
    opportunity.createdAt < now - SLACK_OPPORTUNITY_EXPIRY_MS
  );
}

/** True for a Slack opportunity that passed the expiry before the cutover. */
export function isStaleSlackBacklog(opportunity: Doc<"opportunities">): boolean {
  return (
    isQualifiedSlackDeal(opportunity) &&
    opportunity.createdAt < STALE_EXPIRY_CUTOVER_AT - SLACK_OPPORTUNITY_EXPIRY_MS
  );
}

/**
 * Closes one Slack opportunity that never booked. Re-checks it first, so a
 * booking that joined it in the meantime wins. Returns whether it closed.
 */
export async function expireStaleSlackOpportunity(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  now: number,
): Promise<boolean> {
  const opportunity = await ctx.db.get("opportunities", opportunityId);
  if (!isStillStale(opportunity, now)) {
    return false;
  }
  await transitionOpportunity(ctx, opportunityId, {
    to: { stage: "closed", outcome: "lost" },
    fields: {
      lostAt: now,
      lostReason: SLACK_STALE_LOST_REASON,
      updatedAt: now,
      // Nobody worked the deal, so it keeps its place in activity sorts.
      latestActivityAt:
        opportunity.latestActivityAt ?? computeLatestActivityAt(opportunity),
    },
    source: "system",
    reason: SLACK_STALE_LOST_REASON,
    metadata: { trigger: "slack_join_window_expired" },
    occurredAt: now,
  });
  await recordSlackDealExpired(ctx, opportunity.leadId, now);
  return true;
}

/**
 * Hourly. Finds Slack opportunities that passed the expiry since the cutover,
 * across tenants, and schedules one mutation per opportunity, so a row that
 * fails can't hold up the others.
 */
export const expireStaleSlackOpportunities = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const now = Date.now();
    const page = await ctx.db
      .query("opportunities")
      .withIndex("by_source_and_stage_and_createdAt", (q) =>
        q
          .eq("source", "slack_qualified")
          .eq("stage", "qualified")
          .gte("createdAt", STALE_EXPIRY_CUTOVER_AT - SLACK_OPPORTUNITY_EXPIRY_MS)
          .lt("createdAt", now - SLACK_OPPORTUNITY_EXPIRY_MS),
      )
      .paginate({ cursor: cursor ?? null, numItems: SCAN_PAGE_SIZE });

    for (const opportunity of page.page) {
      await ctx.scheduler.runAfter(0, internal.slack.staleExpiry.expireOne, {
        opportunityId: opportunity._id,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.slack.staleExpiry.expireStaleSlackOpportunities,
        { cursor: page.continueCursor },
      );
    }
    if (page.page.length > 0) {
      log.info("slack.stale_opportunities.scheduled", {
        count: page.page.length,
        hasMore: !page.isDone,
      });
    }
    return null;
  },
});

export const expireOne = internalMutation({
  args: { opportunityId: v.id("opportunities") },
  returns: v.boolean(),
  handler: async (ctx, { opportunityId }) =>
    await expireStaleSlackOpportunity(ctx, opportunityId, Date.now()),
});

/**
 * Read-only: Slack opportunities past the expiry, split into the backlog the
 * cron leaves for the migration and the ones the cron will close.
 */
export const previewStaleSlackOpportunities = internalQuery({
  args: {},
  returns: v.object({
    backlog: v.number(),
    cronWillClose: v.number(),
    capped: v.boolean(),
    oldestCreatedAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx) => {
    const expiredBefore = Date.now() - SLACK_OPPORTUNITY_EXPIRY_MS;
    const stale = await ctx.db
      .query("opportunities")
      .withIndex("by_source_and_stage_and_createdAt", (q) =>
        q
          .eq("source", "slack_qualified")
          .eq("stage", "qualified")
          .lt("createdAt", expiredBefore),
      )
      .take(PREVIEW_LIMIT + 1);
    const counted = stale.slice(0, PREVIEW_LIMIT);
    const backlogBefore = STALE_EXPIRY_CUTOVER_AT - SLACK_OPPORTUNITY_EXPIRY_MS;
    const backlog = counted.filter((o) => o.createdAt < backlogBefore).length;
    return {
      backlog,
      cronWillClose: counted.length - backlog,
      capped: stale.length > PREVIEW_LIMIT,
      oldestCreatedAt: counted[0]?.createdAt ?? null,
    };
  },
});
