import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

export const MAX_QUALIFICATION_EVENTS = 1000;

/** Upper bound on same-day Slack events scanned when computing the goal counter. */
export const MAX_DAILY_GOAL_EVENT_SCAN = 10_001;

export const GOAL_ELIGIBLE_QUALIFICATION_RESULT_KINDS = new Set<
  Doc<"slackQualificationEvents">["resultKind"]
>(["created_opportunity", "already_booked"]);

export type QualificationEventSummary = {
  qualificationEventCount: number;
  uniqueLinkedOpportunityCount: number;
  uniqueSlackOpportunityCount: number;
  createdOpportunityEvents: number;
  duplicatePendingEvents: number;
  alreadyBookedEvents: number;
  unlinkedEvents: number;
};

export async function countGoalEligibleQualificationEvents(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    start: number;
    end: number;
  },
): Promise<{ count: number; truncated: boolean }> {
  const rows = await ctx.db
    .query("slackQualificationEvents")
    .withIndex("by_tenantId_and_submittedAt", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .gte("submittedAt", args.start)
        .lt("submittedAt", args.end),
    )
    .take(MAX_DAILY_GOAL_EVENT_SCAN);

  let count = 0;
  for (const row of rows) {
    if (GOAL_ELIGIBLE_QUALIFICATION_RESULT_KINDS.has(row.resultKind)) {
      count += 1;
    }
  }

  return {
    count,
    truncated: rows.length >= MAX_DAILY_GOAL_EVENT_SCAN,
  };
}

export async function listQualificationEventsForRange(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    start: number;
    end: number;
    slackUserId?: string;
  },
): Promise<{ rows: Doc<"slackQualificationEvents">[]; truncated: boolean }> {
  const query = args.slackUserId
    ? ctx.db
        .query("slackQualificationEvents")
        .withIndex("by_tenantId_and_slackUserId_and_submittedAt", (q) =>
          q
            .eq("tenantId", args.tenantId)
            .eq("slackUserId", args.slackUserId!)
            .gte("submittedAt", args.start)
            .lt("submittedAt", args.end),
        )
    : ctx.db
        .query("slackQualificationEvents")
        .withIndex("by_tenantId_and_submittedAt", (q) =>
          q
            .eq("tenantId", args.tenantId)
            .gte("submittedAt", args.start)
            .lt("submittedAt", args.end),
        );

  const rows = await query.take(MAX_QUALIFICATION_EVENTS + 1);
  return {
    rows: rows.slice(0, MAX_QUALIFICATION_EVENTS),
    truncated: rows.length > MAX_QUALIFICATION_EVENTS,
  };
}

export async function loadOpportunityMapForQualificationEvents(
  ctx: QueryCtx,
  rows: Doc<"slackQualificationEvents">[],
): Promise<Map<Id<"opportunities">, Doc<"opportunities">>> {
  const opportunityIds = [
    ...new Set(
      rows
        .map((row) => row.opportunityId)
        .filter((id): id is Id<"opportunities"> => id !== undefined),
    ),
  ];

  const opportunities = await Promise.all(
    opportunityIds.map(async (opportunityId) => ctx.db.get(opportunityId)),
  );

  return new Map(
    opportunities
      .filter((opportunity): opportunity is Doc<"opportunities"> =>
        Boolean(opportunity),
      )
      .map((opportunity) => [opportunity._id, opportunity]),
  );
}

export function summarizeQualificationEvents(
  rows: Doc<"slackQualificationEvents">[],
  opportunityById: Map<Id<"opportunities">, Doc<"opportunities">>,
): QualificationEventSummary {
  const uniqueLinkedOpportunityIds = new Set<Id<"opportunities">>();
  const uniqueSlackOpportunityIds = new Set<Id<"opportunities">>();
  let createdOpportunityEvents = 0;
  let duplicatePendingEvents = 0;
  let alreadyBookedEvents = 0;
  let unlinkedEvents = 0;

  for (const row of rows) {
    if (row.opportunityId) {
      uniqueLinkedOpportunityIds.add(row.opportunityId);
      if (opportunityById.get(row.opportunityId)?.source === "slack_qualified") {
        uniqueSlackOpportunityIds.add(row.opportunityId);
      }
    }

    switch (row.resultKind) {
      case "created_opportunity":
        createdOpportunityEvents += 1;
        break;
      case "duplicate_pending":
        duplicatePendingEvents += 1;
        break;
      case "already_booked":
        alreadyBookedEvents += 1;
        break;
      case "unlinked":
        unlinkedEvents += 1;
        break;
    }
  }

  return {
    qualificationEventCount: rows.length,
    uniqueLinkedOpportunityCount: uniqueLinkedOpportunityIds.size,
    uniqueSlackOpportunityCount: uniqueSlackOpportunityIds.size,
    createdOpportunityEvents,
    duplicatePendingEvents,
    alreadyBookedEvents,
    unlinkedEvents,
  };
}
