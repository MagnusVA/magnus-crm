import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import {
  listQualificationEventsForRange,
  loadOpportunityMapForQualificationEvents,
  summarizeQualificationEvents,
} from "./slackQualificationLedger";

export type SlackUserQualificationBreakdownRow = {
  slackUserId: string;
  displayName: string | null;
  avatarUrl: string | null;
  isDeleted: boolean;
  total: number;
  qualificationEventCount: number;
  uniqueOpportunityCount: number;
  booked: number;
  ratio: number | null;
};

export async function buildSlackUserQualificationBreakdown(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    windowStart: number;
    windowEnd: number;
    limit: number;
  },
) {
  const events = await listQualificationEventsForRange(ctx, {
    tenantId: args.tenantId,
    start: args.windowStart,
    end: args.windowEnd,
  });
  const opportunityById = await loadOpportunityMapForQualificationEvents(
    ctx,
    events.rows,
  );
  const eventsBySlackUserId = new Map<string, typeof events.rows>();

  for (const event of events.rows) {
    const current = eventsBySlackUserId.get(event.slackUserId) ?? [];
    current.push(event);
    eventsBySlackUserId.set(event.slackUserId, current);
  }

  const rangeSummary = summarizeQualificationEvents(
    events.rows,
    opportunityById,
  );

  const rows: SlackUserQualificationBreakdownRow[] = [];
  for (const [slackUserId, userEvents] of eventsBySlackUserId) {
    const summary = summarizeQualificationEvents(userEvents, opportunityById);
    const uniqueSlackOpportunities = getUniqueSlackOpportunities(
      userEvents,
      opportunityById,
    );
    const booked = uniqueSlackOpportunities.filter(
      (opportunity) => opportunity.latestMeetingId !== undefined,
    ).length;
    const user = await ctx.db
      .query("slackUsers")
      .withIndex("by_tenantId_and_slackUserId", (q) =>
        q.eq("tenantId", args.tenantId).eq("slackUserId", slackUserId),
      )
      .unique();

    rows.push({
      slackUserId,
      displayName:
        user?.displayName ?? user?.realName ?? user?.username ?? null,
      avatarUrl: user?.avatarUrl ?? null,
      isDeleted: user?.isDeleted ?? false,
      total: summary.qualificationEventCount,
      qualificationEventCount: summary.qualificationEventCount,
      uniqueOpportunityCount: summary.uniqueSlackOpportunityCount,
      booked,
      ratio:
        summary.uniqueSlackOpportunityCount === 0
          ? null
          : booked / summary.uniqueSlackOpportunityCount,
    });
  }

  return {
    rows: rows
      .sort(
        (left, right) =>
          right.total - left.total ||
          right.booked - left.booked ||
          (left.displayName ?? left.slackUserId).localeCompare(
            right.displayName ?? right.slackUserId,
          ),
      )
      .slice(0, args.limit),
    totalQualified: rangeSummary.uniqueSlackOpportunityCount,
    truncated: events.truncated,
  };
}

function getUniqueSlackOpportunities(
  rows: Array<{ opportunityId?: Id<"opportunities"> }>,
  opportunityById: ReadonlyMap<
    Id<"opportunities">,
    Pick<Doc<"opportunities">, "_id" | "source" | "latestMeetingId" | "status">
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
    .filter((opportunity): opportunity is NonNullable<typeof opportunity> =>
      Boolean(opportunity && opportunity.source === "slack_qualified"),
    );
}
