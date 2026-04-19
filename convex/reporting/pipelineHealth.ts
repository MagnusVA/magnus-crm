import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { opportunityByStatus } from "./aggregates";
import { assertValidDateRange, getUserDisplayName } from "./lib/helpers";

const OPPORTUNITY_STATUSES = [
  "scheduled",
  "in_progress",
  "meeting_overran",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "payment_received",
  "lost",
  "canceled",
  "no_show",
] as const satisfies ReadonlyArray<Doc<"opportunities">["status"]>;

const ACTIVE_PIPELINE_STATUSES = [
  "scheduled",
  "in_progress",
  "meeting_overran",
  "follow_up_scheduled",
  "reschedule_link_sent",
] as const satisfies ReadonlyArray<Doc<"opportunities">["status"]>;

const MAX_STALE_OPPORTUNITIES = 20;
const MAX_VELOCITY_ROWS = 500;
const REPORT_ROW_CAP = 2000;
const MAX_PENDING_REVIEW_SCAN_ROWS = REPORT_ROW_CAP + 1;
const MAX_UNRESOLVED_REMINDER_SCAN_ROWS = REPORT_ROW_CAP + 1;
const MAX_NO_SHOW_SCAN_ROWS = REPORT_ROW_CAP + 1;
const MAX_LOSS_SCAN_ROWS = REPORT_ROW_CAP + 1;
const STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;

type NoShowSource = "closer" | "calendly_webhook" | "none";
type LossAttributionRole = "admin" | "closer" | "unknown";
type ReminderCreatedSource = "closer" | "admin" | "system";

function emptyNoShowSourceSplit(): Record<NoShowSource, number> {
  return {
    closer: 0,
    calendly_webhook: 0,
    none: 0,
  };
}

function emptyReminderCreatedSourceSplit(): Record<ReminderCreatedSource, number> {
  return {
    closer: 0,
    admin: 0,
    system: 0,
  };
}

function toNoShowSource(
  source: Doc<"meetings">["noShowSource"],
): NoShowSource {
  switch (source) {
    case "closer":
      return "closer";
    case "calendly_webhook":
      return "calendly_webhook";
    case undefined:
      return "none";
    default:
      return "none";
  }
}

function toReminderCreatedSource(
  source: Doc<"followUps">["createdSource"],
): ReminderCreatedSource {
  switch (source) {
    case "closer":
      return "closer";
    case "admin":
      return "admin";
    case "system":
    case undefined:
      return "system";
    default:
      return "system";
  }
}

function toLossAttributionRole(
  role: Doc<"users">["role"] | null | undefined,
): LossAttributionRole {
  switch (role) {
    case "tenant_master":
    case "tenant_admin":
      return "admin";
    case "closer":
      return "closer";
    case undefined:
    case null:
      return "unknown";
    default:
      return "unknown";
  }
}

export const getPipelineDistribution = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const counts = await opportunityByStatus.countBatch(
      ctx,
      OPPORTUNITY_STATUSES.map((status) => ({
        namespace: tenantId,
        bounds: { prefix: [status] },
      })),
    );

    return {
      distribution: OPPORTUNITY_STATUSES.map((status, index) => ({
        status,
        count: counts[index] ?? 0,
      })),
    };
  },
});

export const getPipelineAging = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const now = Date.now();
    const agingByStatus: Record<
      string,
      { averageAgeDays: number | null; count: number; oldestAgeDays: number | null }
    > = {};
    const staleCandidates: Array<{
      ageDays: number;
      nextMeetingAt: number | null;
      opportunity: Doc<"opportunities">;
    }> = [];
    let staleCount = 0;

    for (const status of ACTIVE_PIPELINE_STATUSES) {
      let opportunityCount = 0;
      let totalAgeDays = 0;
      let oldestAgeDays = 0;

      // `nextMeetingAt` is not indexed, so exact stale counts require scanning
      // the active pipeline rows instead of relying on the capped sample list.
      for await (const opportunity of ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_status", (q) =>
          q.eq("tenantId", tenantId).eq("status", status),
        )) {
        opportunityCount += 1;
        const ageDays = (now - opportunity.createdAt) / 86400000;
        totalAgeDays += ageDays;
        oldestAgeDays = Math.max(oldestAgeDays, ageDays);

        if (
          opportunity.nextMeetingAt === undefined ||
          opportunity.nextMeetingAt < now - STALE_THRESHOLD_MS
        ) {
          staleCount += 1;
          staleCandidates.push({
            opportunity,
            ageDays,
            nextMeetingAt: opportunity.nextMeetingAt ?? null,
          });
        }
      }

      agingByStatus[status] = {
        count: opportunityCount,
        averageAgeDays:
          opportunityCount > 0 ? totalAgeDays / opportunityCount : null,
        oldestAgeDays: opportunityCount > 0 ? oldestAgeDays : null,
      };
    }

    const velocityRows = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("status", "payment_received")
          .gte("createdAt", now - 90 * 24 * 60 * 60 * 1000),
      )
      .take(MAX_VELOCITY_ROWS + 1);
    const wonRows = velocityRows.slice(0, MAX_VELOCITY_ROWS);

    let velocityTotalDays = 0;
    let velocityCount = 0;
    for (const opportunity of wonRows) {
      if (opportunity.paymentReceivedAt === undefined) {
        continue;
      }
      velocityTotalDays +=
        (opportunity.paymentReceivedAt - opportunity.createdAt) / 86400000;
      velocityCount += 1;
    }

    const staleOpportunities = staleCandidates
      .sort((left, right) => right.ageDays - left.ageDays)
      .slice(0, MAX_STALE_OPPORTUNITIES);

    const leadIds = [
      ...new Set(staleOpportunities.map((entry) => entry.opportunity.leadId)),
    ];
    const closerIds = [
      ...new Set(
        staleOpportunities
          .map((entry) => entry.opportunity.assignedCloserId)
          .filter((closerId): closerId is Id<"users"> => closerId !== undefined),
      ),
    ];
    const [leadDocs, closerDocs] = await Promise.all([
      Promise.all(leadIds.map(async (leadId) => [leadId, await ctx.db.get(leadId)] as const)),
      Promise.all(
        closerIds.map(async (closerId) => [closerId, await ctx.db.get(closerId)] as const),
      ),
    ]);
    const leadById = new Map(leadDocs);
    const closerById = new Map(closerDocs);

    return {
      agingByStatus,
      velocityDays: velocityCount > 0 ? velocityTotalDays / velocityCount : null,
      staleCount,
      staleOpps: staleOpportunities.map(({ opportunity, ageDays, nextMeetingAt }) => ({
        opportunityId: opportunity._id,
        status: opportunity.status,
        ageDays: Math.round(ageDays * 10) / 10,
        nextMeetingAt,
        assignedCloserId: opportunity.assignedCloserId ?? null,
        assignedCloserName: opportunity.assignedCloserId
          ? getUserDisplayName(closerById.get(opportunity.assignedCloserId) ?? null)
          : null,
        leadId: opportunity.leadId,
        leadName:
          leadById.get(opportunity.leadId)?.fullName ??
          leadById.get(opportunity.leadId)?.email ??
          null,
      })),
      isAgingTruncated: false,
      isVelocityTruncated: velocityRows.length > MAX_VELOCITY_ROWS,
    };
  },
});

export const getPipelineBacklogAndLoss = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    assertValidDateRange(startDate, endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const pendingReviewRows = await ctx.db
      .query("meetingReviews")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "pending"),
      )
      .take(MAX_PENDING_REVIEW_SCAN_ROWS);

    const pendingFollowUpRows = await ctx.db
      .query("followUps")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "pending"),
      )
      .take(MAX_UNRESOLVED_REMINDER_SCAN_ROWS);

    const noShowRows = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("status", "no_show")
          .gte("scheduledAt", startDate)
          .lt("scheduledAt", endDate),
      )
      .take(MAX_NO_SHOW_SCAN_ROWS);

    const lostOpportunityRows = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_status", (q) =>
        q.eq("tenantId", tenantId).eq("status", "lost"),
      )
      .take(MAX_LOSS_SCAN_ROWS);

    const unresolvedManualReminders = pendingFollowUpRows
      .slice(0, REPORT_ROW_CAP)
      .filter((followUp) => followUp.type === "manual_reminder");
    const unresolvedReminderSplit = emptyReminderCreatedSourceSplit();
    for (const followUp of unresolvedManualReminders) {
      unresolvedReminderSplit[toReminderCreatedSource(followUp.createdSource)] += 1;
    }

    const noShowMeetings = noShowRows.slice(0, REPORT_ROW_CAP);
    const noShowSourceSplit = emptyNoShowSourceSplit();
    for (const meeting of noShowMeetings) {
      noShowSourceSplit[toNoShowSource(meeting.noShowSource)] += 1;
    }

    const lostOpportunities = lostOpportunityRows
      .slice(0, REPORT_ROW_CAP)
      .filter(
        (opportunity) =>
          opportunity.lostAt !== undefined &&
          opportunity.lostAt >= startDate &&
          opportunity.lostAt < endDate,
      );

    const lossCountsByActor = new Map<Id<"users">, number>();
    let unknownLossCount = 0;

    for (const opportunity of lostOpportunities) {
      if (!opportunity.lostByUserId) {
        unknownLossCount += 1;
        continue;
      }

      lossCountsByActor.set(
        opportunity.lostByUserId,
        (lossCountsByActor.get(opportunity.lostByUserId) ?? 0) + 1,
      );
    }

    const actorIds = [...lossCountsByActor.keys()];
    const actorDocs = await Promise.all(
      actorIds.map(async (actorId) => [actorId, await ctx.db.get(actorId)] as const),
    );
    const actorById = new Map(actorDocs);

    const byActor = actorIds
      .map((actorId) => {
        const actor = actorById.get(actorId);
        return {
          userId: actorId,
          actorName: actor ? getUserDisplayName(actor) : "Removed user",
          actorRole: toLossAttributionRole(actor?.role),
          count: lossCountsByActor.get(actorId) ?? 0,
        };
      })
      .sort(
        (left, right) =>
          right.count - left.count ||
          left.actorName.localeCompare(right.actorName),
      );

    const lossAttribution = {
      admin: 0,
      closer: 0,
      unknown: unknownLossCount,
      byActor,
    };

    for (const actor of byActor) {
      lossAttribution[actor.actorRole] += actor.count;
    }

    return {
      pendingReviewsCount: Math.min(pendingReviewRows.length, REPORT_ROW_CAP),
      isPendingReviewsTruncated: pendingReviewRows.length > REPORT_ROW_CAP,
      unresolvedRemindersCount: unresolvedManualReminders.length,
      unresolvedReminderSplit,
      isUnresolvedRemindersTruncated: pendingFollowUpRows.length > REPORT_ROW_CAP,
      noShowSourceSplit,
      isNoShowSourceTruncated: noShowRows.length > REPORT_ROW_CAP,
      lossAttribution,
      isLossAttributionTruncated: lostOpportunityRows.length > REPORT_ROW_CAP,
    };
  },
});
