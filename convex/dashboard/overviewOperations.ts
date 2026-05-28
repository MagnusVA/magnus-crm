import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { DerivedOverviewRange } from "./overviewRange";
import type { PhoneCloserOperations, TopDmCloserRow } from "./overviewTypes";

export const OPERATIONS_STATS_ROW_LIMIT = 1000;

type OperationsStatsRow = Doc<"operationsMeetingDailyStats">;
type OperationsTotals = {
  scheduled: number;
  completed: number;
  noShows: number;
  reviewRequired: number;
};

function emptyTotals(): OperationsTotals {
  return {
    scheduled: 0,
    completed: 0,
    noShows: 0,
    reviewRequired: 0,
  };
}

function addOperationRow(totals: OperationsTotals, row: OperationsStatsRow) {
  totals.scheduled += row.count;
  if (row.meetingStatus === "completed") totals.completed += row.count;
  if (row.meetingStatus === "no_show") totals.noShows += row.count;
  if (row.meetingStatus === "meeting_overran") {
    totals.reviewRequired += row.count;
  }
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
): Promise<{ data: { rows: TopDmCloserRow[] }; isEmpty: boolean }> {
  const rows = await readOperationsStatsRows(ctx, tenantId, range);
  const byDmCloser = new Map<Id<"dmClosers">, OperationsTotals>();

  for (const row of rows) {
    if (!row.dmCloserId) continue;
    const current = byDmCloser.get(row.dmCloserId) ?? emptyTotals();
    addOperationRow(current, row);
    byDmCloser.set(row.dmCloserId, current);
  }

  const enriched: TopDmCloserRow[] = [];
  for (const [dmCloserId, totals] of byDmCloser) {
    const dmCloser = await ctx.db.get(dmCloserId);
    if (!dmCloser || dmCloser.tenantId !== tenantId) continue;
    const team = await ctx.db.get(dmCloser.teamId);

    enriched.push({
      dmCloserId,
      displayName: dmCloser.displayName,
      teamName: team && team.tenantId === tenantId ? team.displayName : null,
      ...totals,
      showRate:
        totals.scheduled === 0 ? null : totals.completed / totals.scheduled,
    });
  }

  const sortedRows = enriched
    .sort(
      (left, right) =>
        right.scheduled - left.scheduled ||
        right.completed - left.completed ||
        left.displayName.localeCompare(right.displayName),
    )
    .slice(0, 5);

  return {
    data: { rows: sortedRows },
    isEmpty: sortedRows.length === 0,
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
    const current = byCloser.get(row.assignedCloserId) ?? emptyTotals();
    addOperationRow(current, row);
    byCloser.set(row.assignedCloserId, current);
  }

  const tableRows: PhoneCloserOperations["rows"] = [];
  for (const [closerId, totals] of byCloser) {
    const closer = await ctx.db.get(closerId);
    const closerName =
      closer && closer.tenantId === tenantId
        ? (closer.fullName ?? closer.email)
        : "Removed closer";

    tableRows.push({
      closerId,
      closerName,
      ...totals,
      showRate:
        totals.scheduled === 0 ? null : totals.completed / totals.scheduled,
      noShowRate:
        totals.scheduled === 0 ? null : totals.noShows / totals.scheduled,
    });
  }

  const sortedRows = tableRows.sort(
    (left, right) =>
      right.scheduled - left.scheduled ||
      left.closerName.localeCompare(right.closerName),
  );
  const totals = sortedRows.reduce(
    (acc, row) => ({
      scheduled: acc.scheduled + row.scheduled,
      completed: acc.completed + row.completed,
      noShows: acc.noShows + row.noShows,
      reviewRequired: acc.reviewRequired + row.reviewRequired,
    }),
    emptyTotals(),
  );

  return {
    data: {
      rows: sortedRows,
      totals: {
        ...totals,
        showRate:
          totals.scheduled === 0 ? null : totals.completed / totals.scheduled,
        noShowRate:
          totals.scheduled === 0 ? null : totals.noShows / totals.scheduled,
      },
    },
    isEmpty: sortedRows.length === 0,
  };
}
