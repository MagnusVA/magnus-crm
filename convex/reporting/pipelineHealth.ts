import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { opportunityByStatus } from "./aggregates";
import { getUserDisplayName } from "./lib/helpers";

const OPPORTUNITY_STATUSES = [
  "scheduled",
  "in_progress",
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
  "follow_up_scheduled",
  "reschedule_link_sent",
] as const satisfies ReadonlyArray<Doc<"opportunities">["status"]>;

const MAX_STALE_OPPORTUNITIES = 20;
const MAX_VELOCITY_ROWS = 500;
const MAX_AGING_ROWS_PER_STATUS = 500;
const STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;

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
    let isAgingTruncated = false;

    for (const status of ACTIVE_PIPELINE_STATUSES) {
      const rows = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_status", (q) =>
          q.eq("tenantId", tenantId).eq("status", status),
        )
        .take(MAX_AGING_ROWS_PER_STATUS + 1);

      const opportunities = rows.slice(0, MAX_AGING_ROWS_PER_STATUS);
      if (rows.length > MAX_AGING_ROWS_PER_STATUS) {
        isAgingTruncated = true;
      }

      let totalAgeDays = 0;
      let oldestAgeDays = 0;

      for (const opportunity of opportunities) {
        const ageDays = (now - opportunity.createdAt) / 86400000;
        totalAgeDays += ageDays;
        oldestAgeDays = Math.max(oldestAgeDays, ageDays);

        if (
          opportunity.nextMeetingAt === undefined ||
          opportunity.nextMeetingAt < now - STALE_THRESHOLD_MS
        ) {
          staleCandidates.push({
            opportunity,
            ageDays,
            nextMeetingAt: opportunity.nextMeetingAt ?? null,
          });
        }
      }

      agingByStatus[status] = {
        count: opportunities.length,
        averageAgeDays:
          opportunities.length > 0 ? totalAgeDays / opportunities.length : null,
        oldestAgeDays: opportunities.length > 0 ? oldestAgeDays : null,
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
      isAgingTruncated,
      isVelocityTruncated: velocityRows.length > MAX_VELOCITY_ROWS,
    };
  },
});
