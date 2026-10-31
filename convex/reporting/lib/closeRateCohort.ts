import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import {
  createLiveReadState,
  readLiveDocuments,
  readLiveQueryRows,
} from "../../lib/liveQueryBounds";

/**
 * Close rate, by cohort: of the deals whose first held call falls in a range,
 * the share that are won now.
 *
 * - A deal joins the cohort once, at its first held call (the earliest held
 *   meeting by `scheduledAt`, then creation time), so a follow-up call never
 *   counts the deal again and a deal whose first held call was before the
 *   range stays out.
 * - The deal is credited to that call's closer and booked program.
 * - Won is the deal's outcome now. A deal won after the range still counts
 *   for the range, so a past range's rate rises as its late deals close.
 * - Side deals have no held call and stay out.
 *
 * Payments play no part. ClickHouse reports apply the same rule with
 * `closeRateCohortSql` (convex/analytics/definitions/closeRateCohort.ts).
 */
export type CloseRateCohortCount = {
  closerId: Id<"users">;
  bookingProgramId: Id<"tenantPrograms"> | null;
  cohortDeals: number;
  wonDeals: number;
};

export type CloseRateTally = {
  cohortDeals: number;
  wonDeals: number;
};

export function emptyCloseRateTally(): CloseRateTally {
  return { cohortDeals: 0, wonDeals: 0 };
}

export function closeRateOf(tally: CloseRateTally): number | null {
  return tally.cohortDeals > 0 ? tally.wonDeals / tally.cohortDeals : null;
}

/** Sums cohort counts by a key, such as the closer or the booked program. */
export function tallyCloseRate<K>(
  counts: readonly CloseRateCohortCount[],
  keyOf: (count: CloseRateCohortCount) => K,
): Map<K, CloseRateTally> {
  const tallies = new Map<K, CloseRateTally>();
  for (const count of counts) {
    const key = keyOf(count);
    const tally = tallies.get(key) ?? emptyCloseRateTally();
    tally.cohortDeals += count.cohortDeals;
    tally.wonDeals += count.wonDeals;
    tallies.set(key, tally);
  }
  return tallies;
}

export function totalCloseRateTally(
  counts: readonly CloseRateCohortCount[],
): CloseRateTally {
  return tallyCloseRate(counts, () => "all").get("all") ?? emptyCloseRateTally();
}

export type CloseRateCohortDeal = {
  opportunityId: Id<"opportunities">;
  firstHeldMeetingId: Id<"meetings">;
  firstHeldAt: number;
  closerId: Id<"users">;
  bookingProgramId: Id<"tenantPrograms"> | null;
  won: boolean;
};

/** Counts cohort deals at the grain `closeRateCohortSql` returns. */
export function countCloseRateCohort(
  deals: readonly CloseRateCohortDeal[],
): CloseRateCohortCount[] {
  const counts = new Map<string, CloseRateCohortCount>();
  for (const deal of deals) {
    const key = JSON.stringify([deal.closerId, deal.bookingProgramId]);
    const count = counts.get(key) ?? {
      closerId: deal.closerId,
      bookingProgramId: deal.bookingProgramId,
      cohortDeals: 0,
      wonDeals: 0,
    };
    count.cohortDeals += 1;
    if (deal.won) count.wonDeals += 1;
    counts.set(key, count);
  }
  return [...counts.values()];
}

const DEFAULT_MAX_HELD_MEETINGS = 2000;
// Three reads per held meeting at most (the meeting, its deal's first held
// meeting, the deal), so the budget is larger than the 512 KB default.
const DEFAULT_BYTE_BUDGET = 4 * 1024 * 1024;

async function firstHeldMeeting(
  ctx: QueryCtx,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"meetings"> | null> {
  return await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId_and_status_and_scheduledAt", (q) =>
      q.eq("opportunityId", opportunityId).eq("status", "held"),
    )
    .first();
}

/**
 * The deals whose first held call is in [start, end), read live and bounded.
 * With `closerId`, only the deals whose first held call was that closer's.
 * When a bound is hit the answer is `{ deals: [], capped: true }`: a partial
 * cohort would give a wrong rate, so callers show the rate as unknown.
 */
export async function readCloseRateCohort(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: { start: number; end: number },
  options: {
    closerId?: Id<"users">;
    maxHeldMeetings?: number;
    byteBudget?: number;
  } = {},
): Promise<{ deals: CloseRateCohortDeal[]; capped: boolean }> {
  const { start, end } = range;
  const { closerId } = options;
  const byteBudget = options.byteBudget ?? DEFAULT_BYTE_BUDGET;
  const state = createLiveReadState();

  const heldQuery =
    closerId === undefined
      ? ctx.db
          .query("meetings")
          .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("status", "held")
              .gte("scheduledAt", start)
              .lt("scheduledAt", end),
          )
      : ctx.db
          .query("meetings")
          .withIndex(
            "by_tenantId_and_assignedCloserId_and_status_and_scheduledAt",
            (q) =>
              q
                .eq("tenantId", tenantId)
                .eq("assignedCloserId", closerId)
                .eq("status", "held")
                .gte("scheduledAt", start)
                .lt("scheduledAt", end),
          );
  const held = await readLiveQueryRows(
    heldQuery,
    options.maxHeldMeetings ?? DEFAULT_MAX_HELD_MEETINGS,
    state,
    byteBudget,
  );
  if (held.capped) return { deals: [], capped: true };

  // A deal with several held calls in the range is looked up once.
  const opportunityIds = [
    ...new Set(held.rows.map((meeting) => meeting.opportunityId)),
  ];
  const firsts = await readLiveDocuments(
    opportunityIds,
    async (opportunityId) => await firstHeldMeeting(ctx, opportunityId),
    state,
    byteBudget,
  );
  if (firsts.capped) return { deals: [], capped: true };

  const cohortMeetings = firsts.rows.filter(
    (meeting) =>
      meeting.tenantId === tenantId &&
      meeting.scheduledAt >= start &&
      meeting.scheduledAt < end &&
      (closerId === undefined || meeting.assignedCloserId === closerId),
  );
  const meetingByOpportunity = new Map(
    cohortMeetings.map((meeting) => [meeting.opportunityId, meeting]),
  );
  const opportunities = await readLiveDocuments(
    [...meetingByOpportunity.keys()],
    async (opportunityId) => await ctx.db.get("opportunities", opportunityId),
    state,
    byteBudget,
  );
  if (opportunities.capped) return { deals: [], capped: true };

  const deals: CloseRateCohortDeal[] = [];
  for (const opportunity of opportunities.rows) {
    // A meeting whose deal is gone has no outcome, as in the SQL's inner join.
    if (opportunity.tenantId !== tenantId) continue;
    const meeting = meetingByOpportunity.get(opportunity._id);
    if (!meeting) continue;
    deals.push(cohortDeal(meeting, opportunity));
  }
  return { deals, capped: false };
}

function cohortDeal(
  meeting: Doc<"meetings">,
  opportunity: Doc<"opportunities">,
): CloseRateCohortDeal {
  return {
    opportunityId: opportunity._id,
    firstHeldMeetingId: meeting._id,
    firstHeldAt: meeting.scheduledAt,
    closerId: meeting.assignedCloserId,
    bookingProgramId: meeting.bookingProgramId ?? null,
    won: opportunity.outcome === "won",
  };
}

/**
 * The cohort deal a held meeting starts, or null when the meeting is not its
 * deal's first held call (or the deal is gone). For readers that page through
 * a range's held meetings themselves, such as the operations report job:
 * keeping only the meetings that start a deal counts each deal once.
 */
export async function closeRateCohortDealAt(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  meeting: Doc<"meetings">,
): Promise<CloseRateCohortDeal | null> {
  if (meeting.tenantId !== tenantId || meeting.status !== "held") return null;
  const first = await firstHeldMeeting(ctx, meeting.opportunityId);
  if (first?._id !== meeting._id) return null;
  const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) return null;
  return cohortDeal(meeting, opportunity);
}
