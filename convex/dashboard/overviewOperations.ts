import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  unknownMemberIdentity,
  userMemberIdentity,
} from "../lib/memberIdentity";
import { buildDmCloserEfficiencyRows } from "./overviewLeaderboardBuilders";
import type { DerivedOverviewRange } from "./overviewRange";
import type { PhoneCloserOperations } from "./overviewTypes";

export const OPERATIONS_STATS_ROW_LIMIT = 1000;

type OperationsStatsRow = Doc<"operationsMeetingDailyStats">;
type OperationsTotals = {
  scheduled: number;
  completed: number;
  noShows: number;
  reviewRequired: number;
};

function emptyOperationsTotals(): OperationsTotals {
  return {
    scheduled: 0,
    completed: 0,
    noShows: 0,
    reviewRequired: 0,
  };
}

function addOperationRow(
  totals: OperationsTotals,
  row: OperationsStatsRow,
) {
  totals.scheduled += row.count;
  if (row.meetingStatus === "completed") totals.completed += row.count;
  if (row.meetingStatus === "no_show") totals.noShows += row.count;
}

function toRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function getIdentitySortLabel(
  identity: PhoneCloserOperations["rows"][number]["closer"],
) {
  return identity.name ?? identity.email ?? "Unknown";
}

async function readOperationsStatsRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: DerivedOverviewRange,
) {
  const rows = await ctx.db
    .query("operationsMeetingDailyStats")
    .withIndex("by_tenantId_and_dayKey", (q) =>
      q
        .eq("tenantId", tenantId)
        .gte("dayKey", range.operationsStartDayKey)
        .lt("dayKey", range.operationsEndDayKeyExclusive),
    )
    .take(OPERATIONS_STATS_ROW_LIMIT + 1);

  if (rows.length > OPERATIONS_STATS_ROW_LIMIT) {
    throw new Error("Operations range is too large. Narrow the date range.");
  }

  return rows;
}

export async function getTopDmClosersOverviewSection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: DerivedOverviewRange,
) {
  const { rows, truncated } = await buildDmCloserEfficiencyRows(ctx, {
    tenantId,
    range,
    includeAllCandidates: false,
  });

  return {
    data: {
      rows: rows.slice(0, 5),
      totalBooked: rows.reduce((sum, row) => sum + row.booked, 0),
    },
    truncated,
    isEmpty: rows.length === 0,
  };
}

export async function getPhoneCloserOperationsOverviewSection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: DerivedOverviewRange,
): Promise<{ data: PhoneCloserOperations; isEmpty: boolean }> {
  const rows = await readOperationsStatsRows(ctx, tenantId, range);
  const byCloser = new Map<Id<"users">, OperationsTotals>();

  for (const row of rows) {
    const current = byCloser.get(row.assignedCloserId) ?? emptyOperationsTotals();
    addOperationRow(current, row);
    byCloser.set(row.assignedCloserId, current);
  }

  const tableRows: PhoneCloserOperations["rows"] = [];
  for (const [closerId, totals] of byCloser) {
    const closer = await ctx.db.get(closerId);
    const validCloser = closer && closer.tenantId === tenantId ? closer : null;
    const closerIdentity = validCloser
      ? await userMemberIdentity(ctx, validCloser)
      : unknownMemberIdentity("Removed closer", "unknown");

    tableRows.push({
      closerId,
      closer: closerIdentity,
      ...totals,
      showRate: toRate(totals.completed, totals.scheduled),
      noShowRate: toRate(totals.noShows, totals.scheduled),
    });
  }

  const sortedRows = tableRows.sort(
    (left, right) =>
      right.scheduled - left.scheduled ||
      getIdentitySortLabel(left.closer).localeCompare(
        getIdentitySortLabel(right.closer),
      ),
  );
  const operationTotals = [...byCloser.values()].reduce(
    (acc, totals) => ({
      scheduled: acc.scheduled + totals.scheduled,
      completed: acc.completed + totals.completed,
      noShows: acc.noShows + totals.noShows,
      reviewRequired: acc.reviewRequired + totals.reviewRequired,
    }),
    emptyOperationsTotals(),
  );

  return {
    data: {
      rows: sortedRows,
      totals: {
        scheduled: operationTotals.scheduled,
        completed: operationTotals.completed,
        noShows: operationTotals.noShows,
        reviewRequired: operationTotals.reviewRequired,
        showRate: toRate(operationTotals.completed, operationTotals.scheduled),
        noShowRate: toRate(operationTotals.noShows, operationTotals.scheduled),
      },
    },
    isEmpty: sortedRows.length === 0,
  };
}
