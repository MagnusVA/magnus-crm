import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { isSideDeal } from "../lib/sideDeals";

const STALE_THRESHOLD_MS = 72 * 60 * 60 * 1000;
const BATCH_SIZE = 50;

export const nudgeStaleSideDeals = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    cutoff: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const cutoff = args.cutoff ?? now - STALE_THRESHOLD_MS;

    const page = await ctx.db
      .query("opportunities")
      .withIndex("by_source_and_status_and_createdAt", (q) =>
        q
          .eq("source", "side_deal")
          .eq("status", "in_progress")
          .lt("createdAt", cutoff),
      )
      .order("asc")
      .paginate({ numItems: BATCH_SIZE, cursor: args.cursor ?? null });

    let nudged = 0;

    for (const opportunity of page.page) {
      if (!isSideDeal(opportunity) || opportunity.status !== "in_progress") {
        continue;
      }
      if (!opportunity.assignedCloserId) {
        continue;
      }

      const payment = await ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId", (q) =>
          q.eq("opportunityId", opportunity._id),
        )
        .first();
      if (payment) {
        continue;
      }

      const meeting = await ctx.db
        .query("meetings")
        .withIndex("by_opportunityId", (q) =>
          q.eq("opportunityId", opportunity._id),
        )
        .first();
      if (meeting) {
        continue;
      }

      const pendingNudge = await ctx.db
        .query("followUps")
        .withIndex("by_opportunityId_and_status_and_reason", (q) =>
          q
            .eq("opportunityId", opportunity._id)
            .eq("status", "pending")
            .eq("reason", "stale_opportunity_nudge"),
        )
        .first();
      if (pendingNudge) {
        continue;
      }

      const followUps = await ctx.db
        .query("followUps")
        .withIndex("by_opportunityId", (q) =>
          q.eq("opportunityId", opportunity._id),
        )
        .take(50);
      if (followUps.length === 50) {
        continue;
      }
      if (
        followUps.some(
          (followUp) => followUp.reason !== "stale_opportunity_nudge",
        )
      ) {
        continue;
      }

      const ageMs = now - opportunity.createdAt;
      const ageHours = Math.floor(ageMs / (60 * 60 * 1000));

      await ctx.db.insert("followUps", {
        tenantId: opportunity.tenantId,
        opportunityId: opportunity._id,
        leadId: opportunity.leadId,
        closerId: opportunity.assignedCloserId,
        type: "manual_reminder",
        reason: "stale_opportunity_nudge",
        status: "pending",
        reminderScheduledAt: now,
        reminderNote:
          `This side-deal opportunity has been sitting for ${ageHours}h without activity. ` +
          "Record payment, mark it lost, or delete it if it was created by mistake.",
        createdAt: now,
        createdSource: "system",
      });

      await emitDomainEvent(ctx, {
        tenantId: opportunity.tenantId,
        entityType: "opportunity",
        entityId: opportunity._id,
        eventType: "opportunity.stale_flagged",
        source: "system",
        occurredAt: now,
        metadata: {
          source: "side_deal",
          ageMs,
          thresholdMs: STALE_THRESHOLD_MS,
        },
      });

      nudged += 1;
    }

    console.log(
      "[Opportunities:Staleness] scanned=%d nudged=%d",
      page.page.length,
      nudged,
    );

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.opportunities.staleness.nudgeStaleSideDeals,
        {
          cursor: page.continueCursor,
          cutoff,
        },
      );
    }

    return null;
  },
});
