import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { OpportunityStatus } from "../lib/statusTransitions";
import { legacyStatus, loadPendingRescheduleLink } from "./dealState";
import {
  DEAL_POSITIONS,
  dealStageOf,
  isAllowedStageOutcome,
  stageOfPosition,
  type DealPosition,
} from "./stages";
import { opportunityStatusValidator } from "./validators";
import {
  compareCloseRatesArgs,
  compareCloseRatesPage,
  compareCloseRatesReturns,
  comparePipelineHealthArgs,
  comparePipelineHealthPage,
  comparePipelineHealthReturns,
  compareStageCountsArgs,
  compareStageCountsPage,
  compareStageCountsReturns,
  compareTeamOutcomesArgs,
  compareTeamOutcomesPage,
  compareTeamOutcomesReturns,
} from "./stageParityReports";

// Parity (docs/plans/phase-5-deal-status.md §10.4): each number a moved
// reader shows, computed from the status and from the stage, with the
// differences, IDs and counts only. Run in production before the PR that
// moves the reader deploys; PR 9 removes this module with the status.
//
// Each query lives in its own section below.

// ---------------------------------------------------------------------------
// compareDealState (PR 3): each deal's legacyStatus against its status.
// ---------------------------------------------------------------------------

const DEAL_STATE_PAGE_DEFAULT = 200;
const DEAL_STATE_PAGE_MAX = 500;

/**
 * Read-only: for one page of the tenant's deals, every deal whose status
 * rebuilt from its stage, outcome, loss and tasks (`legacyStatus`, §4.6)
 * isn't its stored status. `legacy` is null when the stage doesn't allow the
 * outcome. Page with `continueCursor` until `isDone`.
 */
export const compareDealState = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.optional(v.number()),
  },
  returns: v.object({
    checked: v.number(),
    mismatches: v.array(
      v.object({
        opportunityId: v.id("opportunities"),
        status: opportunityStatusValidator,
        legacy: v.union(opportunityStatusValidator, v.null()),
      }),
    ),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, { tenantId, cursor, numItems = DEAL_STATE_PAGE_DEFAULT }) => {
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > DEAL_STATE_PAGE_MAX) {
      throw new Error(`numItems must be a whole number from 1 to ${DEAL_STATE_PAGE_MAX}`);
    }
    const page = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .paginate({ cursor, numItems });

    const mismatches = [];
    for (const deal of page.page) {
      const { stage, outcome } = dealStageOf(deal);
      let legacy = null;
      if (isAllowedStageOutcome(stage, outcome)) {
        // Only a Follow-up deal's status reads its reschedule link.
        const links = stage === "follow_up" ? (await loadPendingRescheduleLink(ctx, deal._id)).count : 0;
        legacy = legacyStatus(deal, { hasPendingRescheduleLink: links > 0 });
      }
      if (legacy !== deal.status) {
        mismatches.push({ opportunityId: deal._id, status: deal.status, legacy });
      }
    }
    return {
      checked: page.page.length,
      mismatches,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

// ---------------------------------------------------------------------------
// compareQualificationQueue (PR 3): the Qualifications filter by position,
// through the row's dealStage and dealOutcome, against the statuses each
// position holds, through opportunityStatus.
// ---------------------------------------------------------------------------

// The statuses each position holds. A scheduled side deal is Call held, and
// a row doesn't carry the source, so Booked and Call held are checked
// together against scheduled.
const QUALIFICATION_QUEUE_CHECKS: {
  positions: DealPosition[];
  statuses: OpportunityStatus[];
}[] = [
  { positions: ["qualified"], statuses: ["qualified_pending"] },
  { positions: ["booked", "call_held"], statuses: ["scheduled"] },
  { positions: ["follow_up"], statuses: ["follow_up_scheduled", "reschedule_link_sent"] },
  { positions: ["won"], statuses: ["payment_received"] },
  { positions: ["lost"], statuses: ["lost", "canceled", "no_show"] },
];

// Fourteen index reads (six positions, eight statuses) of at most this many
// rows each stay well under a query's document and byte limits.
const QUALIFICATION_QUEUE_READ_MAX = 500;

const qualificationQueuePositionValidator = v.union(
  v.literal("qualified"),
  v.literal("booked"),
  v.literal("call_held"),
  v.literal("follow_up"),
  v.literal("won"),
  v.literal("lost"),
);

type QueueCount = { count: number; truncated: boolean };

/** Up to `max` rows of an index range, and whether there were more. */
async function countQueueRows(
  query: { take(n: number): Promise<unknown[]> },
  max: number,
): Promise<QueueCount> {
  const rows = await query.take(max + 1);
  return { count: Math.min(rows.length, max), truncated: rows.length > max };
}

function sumQueueCounts(counts: (QueueCount | undefined)[]): QueueCount {
  return counts.reduce<QueueCount>(
    (total, count) => ({
      count: total.count + (count?.count ?? 0),
      truncated: total.truncated || (count?.truncated ?? false),
    }),
    { count: 0, truncated: false },
  );
}

/**
 * Read-only: for one tenant and qualifiedAt in [qualifiedAfter,
 * qualifiedBefore), the qualification rows each position's filter returns
 * through `by_tenantId_and_dealStage_and_dealOutcome_and_qualifiedAt`,
 * against the rows of its statuses through
 * `by_tenantId_and_opportunityStatus_and_qualifiedAt` (§10.4). Each read
 * stops at `maxRowsPerRead` (default and most 500); a check it cut short is
 * `truncated` and never matches, so narrow the range and run again. `ok` is
 * true when every check matches.
 */
export const compareQualificationQueue = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    qualifiedAfter: v.number(),
    qualifiedBefore: v.number(),
    maxRowsPerRead: v.optional(v.number()),
  },
  returns: v.object({
    stageCounts: v.object({
      qualified: v.number(),
      booked: v.number(),
      call_held: v.number(),
      follow_up: v.number(),
      won: v.number(),
      lost: v.number(),
    }),
    checks: v.array(
      v.object({
        positions: v.array(qualificationQueuePositionValidator),
        statuses: v.array(opportunityStatusValidator),
        byStage: v.number(),
        byStatus: v.number(),
        match: v.boolean(),
        truncated: v.boolean(),
      }),
    ),
    truncated: v.boolean(),
    ok: v.boolean(),
  }),
  handler: async (
    ctx,
    { tenantId, qualifiedAfter, qualifiedBefore, maxRowsPerRead = QUALIFICATION_QUEUE_READ_MAX },
  ) => {
    if (
      !Number.isFinite(qualifiedAfter) ||
      !Number.isFinite(qualifiedBefore) ||
      qualifiedAfter >= qualifiedBefore
    ) {
      throw new Error("qualifiedAfter must be before qualifiedBefore");
    }
    if (
      !Number.isInteger(maxRowsPerRead) ||
      maxRowsPerRead < 1 ||
      maxRowsPerRead > QUALIFICATION_QUEUE_READ_MAX
    ) {
      throw new Error(
        `maxRowsPerRead must be a whole number from 1 to ${QUALIFICATION_QUEUE_READ_MAX}`,
      );
    }

    const positionCountList = await Promise.all(
      DEAL_POSITIONS.map((position) => {
        const { stage, outcome } = stageOfPosition(position);
        return countQueueRows(
          ctx.db
            .query("operationsQualificationRows")
            .withIndex("by_tenantId_and_dealStage_and_dealOutcome_and_qualifiedAt", (q) =>
              q
                .eq("tenantId", tenantId)
                .eq("dealStage", stage)
                .eq("dealOutcome", outcome)
                .gte("qualifiedAt", qualifiedAfter)
                .lt("qualifiedAt", qualifiedBefore),
            ),
          maxRowsPerRead,
        );
      }),
    );
    const positionCounts = new Map(
      DEAL_POSITIONS.map((position, index) => [position, positionCountList[index]]),
    );

    const statuses = QUALIFICATION_QUEUE_CHECKS.flatMap((check) => check.statuses);
    const statusCountList = await Promise.all(
      statuses.map((status) =>
        countQueueRows(
          ctx.db
            .query("operationsQualificationRows")
            .withIndex("by_tenantId_and_opportunityStatus_and_qualifiedAt", (q) =>
              q
                .eq("tenantId", tenantId)
                .eq("opportunityStatus", status)
                .gte("qualifiedAt", qualifiedAfter)
                .lt("qualifiedAt", qualifiedBefore),
            ),
          maxRowsPerRead,
        ),
      ),
    );
    const statusCounts = new Map(
      statuses.map((status, index) => [status, statusCountList[index]]),
    );

    const checks = QUALIFICATION_QUEUE_CHECKS.map(({ positions, statuses: covered }) => {
      const byStage = sumQueueCounts(positions.map((position) => positionCounts.get(position)));
      const byStatus = sumQueueCounts(covered.map((status) => statusCounts.get(status)));
      const truncated = byStage.truncated || byStatus.truncated;
      return {
        positions,
        statuses: covered,
        byStage: byStage.count,
        byStatus: byStatus.count,
        match: !truncated && byStage.count === byStatus.count,
        truncated,
      };
    });
    const stageCounts = Object.fromEntries(
      DEAL_POSITIONS.map((position) => [position, positionCounts.get(position)?.count ?? 0]),
    ) as Record<DealPosition, number>;
    return {
      stageCounts,
      checks,
      truncated: checks.some((check) => check.truncated),
      ok: checks.every((check) => check.match),
    };
  },
});

// ============================================================================
// Report numbers (PR 3b): compareStageCounts, comparePipelineHealth,
// compareTeamOutcomes, compareCloseRates. The logic is in
// stageParityReports.ts; each comment there says how many calls production
// needs.
// ============================================================================

/** The distribution chart and each closer's pipeline tabs: positions against statuses. */
export const compareStageCounts = internalQuery({
  args: compareStageCountsArgs,
  returns: compareStageCountsReturns,
  handler: async (ctx, args) => await compareStageCountsPage(ctx, args),
});

/** Pipeline Health: aging, the stale list, velocity and loss attribution. */
export const comparePipelineHealth = internalQuery({
  args: comparePipelineHealthArgs,
  returns: comparePipelineHealthReturns,
  handler: async (ctx, args) => await comparePipelineHealthPage(ctx, args),
});

/** The team report's outcome mix per closer, meeting by meeting. */
export const compareTeamOutcomes = internalQuery({
  args: compareTeamOutcomesArgs,
  returns: compareTeamOutcomesReturns,
  handler: async (ctx, args) => await compareTeamOutcomesPage(ctx, args),
});

/** The closer dashboard strip's won, lost and close rate per closer. */
export const compareCloseRates = internalQuery({
  args: compareCloseRatesArgs,
  returns: compareCloseRatesReturns,
  handler: async (ctx, args) => await compareCloseRatesPage(ctx, args),
});

// ============================================================================
// End of report numbers (PR 3b)
// ============================================================================
