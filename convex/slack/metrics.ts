import { v } from "convex/values";
import { query } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  SOCIAL_PLATFORM_LABELS,
  SOCIAL_PLATFORMS,
  type SocialPlatform,
} from "../lib/socialPlatform";
import {
  listQualificationEventsForRange,
  loadOpportunityMapForQualificationEvents,
  summarizeQualificationEvents,
} from "../reporting/lib/slackQualificationLedger";
import { buildSlackUserQualificationBreakdown } from "../reporting/lib/slackQualificationBreakdown";
import { requireTenantUser } from "../requireTenantUser";

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
    const events = await listQualificationEventsForRange(ctx, {
      tenantId,
      start: args.windowStart,
      end: args.windowEnd,
    });
    const opportunityById = await loadOpportunityMapForQualificationEvents(
      ctx,
      events.rows,
    );
    const summary = summarizeQualificationEvents(events.rows, opportunityById);
    const uniqueSlackOpportunities = getUniqueSlackOpportunities(
      events.rows,
      opportunityById,
    );

    const booked = uniqueSlackOpportunities.filter(
      (opportunity) => opportunity.latestMeetingId !== undefined,
    ).length;
    const lost = uniqueSlackOpportunities.filter(
      (opportunity) => opportunity.status === "lost",
    ).length;
    const stillPending = uniqueSlackOpportunities.filter(
      (opportunity) => opportunity.status === "qualified_pending",
    ).length;

    return {
      total: summary.qualificationEventCount,
      qualificationEventCount: summary.qualificationEventCount,
      uniqueOpportunityCount: summary.uniqueSlackOpportunityCount,
      uniqueLinkedOpportunityCount: summary.uniqueLinkedOpportunityCount,
      createdOpportunityEvents: summary.createdOpportunityEvents,
      duplicatePendingEvents: summary.duplicatePendingEvents,
      alreadyBookedEvents: summary.alreadyBookedEvents,
      unlinkedEvents: summary.unlinkedEvents,
      booked,
      lost,
      stillPending,
      ratio:
        summary.uniqueSlackOpportunityCount === 0
          ? null
          : booked / summary.uniqueSlackOpportunityCount,
      truncated: events.truncated,
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

    return await buildSlackUserQualificationBreakdown(ctx, {
      tenantId,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      limit: 25,
    });
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
    const events = await listQualificationEventsForRange(ctx, {
      tenantId,
      start: args.windowStart,
      end: args.windowEnd,
    });
    const opportunityById = await loadOpportunityMapForQualificationEvents(
      ctx,
      events.rows,
    );
    const platformCounts = Object.fromEntries(
      SOCIAL_PLATFORMS.map((platform) => [
        platform,
        {
          total: 0,
          bookedOpportunityIds: new Set<Id<"opportunities">>(),
          opportunityIds: new Set<Id<"opportunities">>(),
        },
      ]),
    ) as Record<
      SocialPlatform,
      {
        total: number;
        bookedOpportunityIds: Set<Id<"opportunities">>;
        opportunityIds: Set<Id<"opportunities">>;
      }
    >;

    for (const event of events.rows) {
      const platform = event.platform;
      const count = platformCounts[platform];
      count.total += 1;

      if (!event.opportunityId) {
        continue;
      }
      const opportunity = opportunityById.get(event.opportunityId);
      if (!opportunity || opportunity.source !== "slack_qualified") {
        continue;
      }
      count.opportunityIds.add(opportunity._id);
      if (opportunity.latestMeetingId !== undefined) {
        count.bookedOpportunityIds.add(opportunity._id);
      }
    }

    return {
      rows: SOCIAL_PLATFORMS.map((platform) => {
        const count = platformCounts[platform];
        const uniqueOpportunityCount = count.opportunityIds.size;
        const booked = count.bookedOpportunityIds.size;
        return {
          platform,
          label: SOCIAL_PLATFORM_LABELS[platform],
          total: count.total,
          uniqueOpportunityCount,
          booked,
          ratio:
            uniqueOpportunityCount === 0 ? null : booked / uniqueOpportunityCount,
        };
      })
        .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total || b.booked - a.booked),
      truncated: events.truncated,
    };
  },
});

function getUniqueSlackOpportunities(
  rows: Array<{ opportunityId?: Id<"opportunities"> }>,
  opportunityById: ReadonlyMap<
    Id<"opportunities">,
    Pick<
      Doc<"opportunities">,
      "_id" | "source" | "latestMeetingId" | "status"
    >
  >,
) {
  const opportunityIds = [
    ...new Set(
      rows
        .map((row) => row.opportunityId)
        .filter((id): id is Id<"opportunities"> => id !== undefined),
    ),
  ];
  return opportunityIds
    .map((opportunityId) => opportunityById.get(opportunityId))
    .filter((opportunity): opportunity is NonNullable<typeof opportunity> => {
      if (!opportunity) {
        return false;
      }
      return opportunity.source === "slack_qualified";
    });
}
