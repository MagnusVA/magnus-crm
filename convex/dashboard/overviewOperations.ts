import { isHeldStatus, withAttendanceCounts } from "../lib/meetingAttendance";
import { requireReportingReady } from "../operations/reportingReadiness";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  unknownMemberIdentity,
  userMemberIdentity,
} from "../lib/memberIdentity";
import type { MeetingStatsCount } from "../operations/meetingStats";
import {
  buildDmCloserEfficiencyRows,
  type DmCloserEfficiencyResult,
} from "./overviewLeaderboardBuilders";
import type { DerivedOverviewRange } from "./overviewRange";
import type { PhoneCloserOperations } from "./overviewTypes";

export const OPERATIONS_STATS_ROW_LIMIT = 8192;

type OperationsStatsRow = MeetingStatsCount;
type OperationsTotals = {
  scheduled: number;
  held: number;
  noShows: number;
  reviewRequired: number;
  notRecorded: number;
};

function emptyOperationsTotals(): OperationsTotals {
  return {
    scheduled: 0,
    held: 0,
    noShows: 0,
    reviewRequired: 0,
    notRecorded: 0,
  };
}

function addOperationRow(
  totals: OperationsTotals,
  row: OperationsStatsRow & { notRecorded: number },
) {
  totals.scheduled += row.count;
  totals.notRecorded += row.notRecorded;
  if (isHeldStatus(row.meetingStatus)) totals.held += row.count;
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
  await requireReportingReady(ctx, tenantId);
  const rows = await ctx.db
    .query("operationsMeetingStatsV2")
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
  return buildTopDmClosersOverviewSection(
    await buildDmCloserEfficiencyRows(ctx, {
      tenantId,
      range,
      includeAllCandidates: false,
    }),
  );
}

export function buildTopDmClosersOverviewSection({
  rows,
  truncated,
}: Pick<DmCloserEfficiencyResult, "rows" | "truncated">) {
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
  return await buildPhoneCloserOperationsOverviewSection(
    ctx,
    tenantId,
    await readOperationsStatsRows(ctx, tenantId, range),
  );
}

/**
 * The phone closer table from the range's operationsMeetingStatsV2 buckets.
 * The Overview ClickHouse report rebuilds the buckets from meetings.
 */
export async function buildPhoneCloserOperationsOverviewSection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rows: MeetingStatsCount[],
): Promise<{ data: PhoneCloserOperations; isEmpty: boolean }> {
  const byCloser = new Map<Id<"users">, OperationsTotals>();

  const attendance = await withAttendanceCounts(ctx, tenantId, rows);
  for (const row of attendance.counts) {
    const current = byCloser.get(row.assignedCloserId) ?? emptyOperationsTotals();
    addOperationRow(current, row);
    byCloser.set(row.assignedCloserId, current);
  }

  const tableRows: PhoneCloserOperations["rows"] = [];
  for (const [closerId, totals] of byCloser) {
    const closer = await ctx.db.get("users", closerId);
    const validCloser = closer && closer.tenantId === tenantId ? closer : null;
    const closerIdentity = validCloser
      ? await userMemberIdentity(ctx, validCloser)
      : unknownMemberIdentity("Removed closer", "unknown");

    tableRows.push({
      closerId,
      closer: closerIdentity,
      ...totals,
      resultsRecorded: totals.held + totals.noShows,
      pastCalls: totals.held + totals.noShows + totals.notRecorded,
      showRate: toRate(totals.held, totals.held + totals.noShows),
      noShowRate: toRate(totals.noShows, totals.held + totals.noShows),
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
      held: acc.held + totals.held,
      noShows: acc.noShows + totals.noShows,
      reviewRequired: acc.reviewRequired + totals.reviewRequired,
      notRecorded: acc.notRecorded + totals.notRecorded,
    }),
    emptyOperationsTotals(),
  );

  return {
    data: {
      attendanceCountsPartial: attendance.attendanceCountsPartial,
      rows: sortedRows,
      totals: {
        scheduled: operationTotals.scheduled,
        held: operationTotals.held,
        noShows: operationTotals.noShows,
        reviewRequired: operationTotals.reviewRequired,
        resultsRecorded: operationTotals.held + operationTotals.noShows,
        pastCalls: operationTotals.held + operationTotals.noShows + operationTotals.notRecorded,
        showRate: toRate(operationTotals.held, operationTotals.held + operationTotals.noShows),
        noShowRate: toRate(operationTotals.noShows, operationTotals.held + operationTotals.noShows),
      },
    },
    isEmpty: sortedRows.length === 0,
  };
}
