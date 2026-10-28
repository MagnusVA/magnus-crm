import { addBusinessDays } from "../../../lib/businessDay";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import type { MeetingStatsCount } from "../../operations/meetingStats";
import {
  buildPipelineBacklogAndLoss,
  buildSchedulingShowRate,
  type getPipelineBacklogAndLoss,
  type getSchedulingShowRateByOperationsDimensions,
} from "../../reporting/pipelineHealth";
import type { SqlRow } from "../clickhouse";
import {
  defineReport,
  noFilters,
  num,
  optionalIdFilter,
  rangeParams,
  str,
  type AnalyticsFilters,
  type ReportInput,
} from "../definition";

// Pipeline Health (app/workspace/reports/pipeline). Distribution, aging and
// the stale list have no range and stay on Convex. The ranged panels get the
// counts their builders take, grouped in SQL, so no cap of the Convex scans
// applies.

const roles = ["tenant_master", "tenant_admin"] as const;

// ── Backlog and loss ────────────────────────────────────────────────────

// The pending reminders are a current-state count with no range; the page
// keeps its card on Convex, but the answer carries them so it has the
// reader's shape. Read as the reader does: by creation, one past its cap.
const PENDING_FOLLOW_UP_SCAN_ROWS = 2001;

function backlogAndLossSql(input: ReportInput<Record<string, never>>) {
  const params = rangeParams(input.range);
  return {
    pending_follow_ups: {
      sql: `
SELECT type, created_source
FROM analytics.followups
WHERE tenant_id = {tenant_id:String}
  AND status = 'pending'
ORDER BY created_at_ms, creation_time_ms
LIMIT ${PENDING_FOLLOW_UP_SCAN_ROWS}`,
    },
    no_show_sources: {
      sql: `
SELECT no_show_source, count() AS count
FROM analytics.meetings
WHERE tenant_id = {tenant_id:String}
  AND status = 'no_show'
  AND scheduled_at_ms >= {from_ms:Int64}
  AND scheduled_at_ms < {to_ms:Int64}
GROUP BY no_show_source`,
      params,
    },
    // A person's losses, as isPersonLoss reads them: Closed lost with the
    // loser recorded, or without one of the system's reason codes. In the
    // order the personLosses aggregate reads them, by when they happened.
    losses: {
      sql: `
SELECT lost_by_user_id, count() AS count
FROM analytics.deals
WHERE tenant_id = {tenant_id:String}
  AND stage = 'closed'
  AND outcome = 'lost'
  AND lost_at_ms >= {from_ms:Int64}
  AND lost_at_ms < {to_ms:Int64}
  AND (ifNull(lost_by_user_id, '') != '' OR ifNull(lost_reason, '') NOT IN ('stale', 'no_show', 'canceled'))
GROUP BY lost_by_user_id
ORDER BY min(lost_at_ms), lost_by_user_id`,
      params,
    },
  };
}

function lossCountsFromRows(rows: SqlRow[] | undefined) {
  const lossCountsByActor = new Map<Id<"users">, number>();
  let unknownLossCount = 0;
  for (const row of rows ?? []) {
    const userId = str(row.lost_by_user_id) as Id<"users"> | null;
    if (userId === null) unknownLossCount += num(row.count);
    else lossCountsByActor.set(userId, num(row.count));
  }
  return { lossCountsByActor, unknownLossCount };
}

// ── Show rate ───────────────────────────────────────────────────────────

type ShowRateFilters = {
  bookingProgramId: Id<"tenantPrograms"> | null;
  attributionTeamId: Id<"attributionTeams"> | null;
  dmCloserId: Id<"dmClosers"> | null;
};

async function parseShowRateFilters(ctx: QueryCtx, raw: AnalyticsFilters): Promise<ShowRateFilters> {
  return {
    bookingProgramId: optionalIdFilter(ctx, "tenantPrograms", raw.bookingProgramId),
    attributionTeamId: optionalIdFilter(ctx, "attributionTeams", raw.attributionTeamId),
    dmCloserId: optionalIdFilter(ctx, "dmClosers", raw.dmCloserId),
  };
}

const BUSINESS_DAY_KEY =
  "toString(toDate(toTimeZone(fromUnixTimestamp64Milli(m.scheduled_at_ms), {tz:String}) - toIntervalHour({day_start_hour:UInt8})))";

// The meetings a team or DM closer filter credits, as creditedMeetingIds in
// convex/operations/meetingStats.ts reads them from dealAttributions: a
// team's dm_team rows, a DM closer's own booking_utm rows under its team
// member, and with both, the meetings on both lists.
const TEAM_MEETINGS = `
SELECT meeting_id
FROM analytics.attributions
WHERE tenant_id = {tenant_id:String}
  AND role = 'dm_team'
  AND team_id = {attribution_team_id:String}
  AND meeting_scheduled_at_ms >= {from_ms:Int64}
  AND meeting_scheduled_at_ms < {to_ms:Int64}
  AND meeting_id IS NOT NULL`;

const DM_CLOSER_MEETINGS = `
SELECT meeting_id
FROM analytics.attributions
WHERE tenant_id = {tenant_id:String}
  AND role = 'dm_closer'
  AND team_member_id IN (
    SELECT team_member_id
    FROM analytics.dm_closers
    WHERE tenant_id = {tenant_id:String}
      AND id = {dm_closer_id:String}
      AND team_member_id IS NOT NULL
  )
  AND meeting_scheduled_at_ms >= {from_ms:Int64}
  AND meeting_scheduled_at_ms < {to_ms:Int64}
  AND meeting_id IS NOT NULL
  AND JSONExtractString(source_json, 'kind') = 'booking_utm'
  AND JSONExtractString(source_json, 'dmCloserId') = {dm_closer_id:String}`;

/**
 * The operationsMeetingStatsV2 rows the reader counts, rebuilt from the
 * meetings: a meeting's contribution is its business day, closer, booked
 * program, its deal's sold program and its status. A credited meeting is its
 * own row, as the reader's projection read is. Only a scheduled call's day,
 * closer and sold program reach a number (withAttendanceCounts), so every
 * other status is summed per booked program at the range's first such day,
 * which keeps a 731-day answer small.
 */
function showRateSql(input: ReportInput<ShowRateFilters>) {
  const { bookingProgramId, attributionTeamId, dmCloserId } = input.filters;
  const credited = attributionTeamId !== null || dmCloserId !== null;
  const creditFilters = [
    attributionTeamId !== null ? `AND m.id IN (${TEAM_MEETINGS})` : "",
    dmCloserId !== null ? `AND m.id IN (${DM_CLOSER_MEETINGS})` : "",
  ].join("\n    ");
  const scheduled = (column: string) => `if(row_status = 'scheduled', ${column}, NULL)`;
  const meetingKey = credited ? scheduled("row_meeting_id") : "NULL";
  return {
    meeting_counts: {
      sql: `
SELECT
  row_status AS meeting_status,
  row_booking_program_id AS booking_program_id,
  ifNull(${scheduled("row_day_key")}, min(row_day_key)) AS day_key,
  ifNull(${scheduled("row_closer_id")}, any(row_closer_id)) AS assigned_closer_id,
  ${scheduled("row_sold_program_id")} AS sold_program_id,
  ${meetingKey} AS meeting_id,
  count() AS count
FROM (
  SELECT
    m.id AS row_meeting_id,
    m.status AS row_status,
    m.booking_program_id AS row_booking_program_id,
    m.assigned_closer_id AS row_closer_id,
    d.sold_program_id AS row_sold_program_id,
    ${BUSINESS_DAY_KEY} AS row_day_key
  FROM analytics.meetings AS m
  INNER JOIN (
    SELECT id, sold_program_id
    FROM analytics.deals
    WHERE tenant_id = {tenant_id:String}
  ) AS d ON d.id = m.opportunity_id
  WHERE m.tenant_id = {tenant_id:String}
    AND m.scheduled_at_ms >= {from_ms:Int64}
    AND m.scheduled_at_ms < {to_ms:Int64}
    ${bookingProgramId !== null ? "AND m.booking_program_id = {booking_program_id:String}" : ""}
    ${creditFilters}
)
GROUP BY
  row_status,
  row_booking_program_id,
  ${scheduled("row_day_key")},
  ${scheduled("row_closer_id")},
  ${scheduled("row_sold_program_id")}${credited ? `,
  ${meetingKey}` : ""}`,
      params: {
        ...rangeParams(input.range),
        ...(bookingProgramId !== null ? { booking_program_id: bookingProgramId } : {}),
        ...(attributionTeamId !== null ? { attribution_team_id: attributionTeamId } : {}),
        ...(dmCloserId !== null ? { dm_closer_id: dmCloserId } : {}),
      },
    },
  };
}

function meetingStatsCounts(rows: SqlRow[] | undefined): MeetingStatsCount[] {
  return (rows ?? []).map((row) => {
    const bookingProgramId = str(row.booking_program_id) as Id<"tenantPrograms"> | null;
    const soldProgramId = str(row.sold_program_id) as Id<"tenantPrograms"> | null;
    const meetingId = str(row.meeting_id) as Id<"meetings"> | null;
    return {
      dayKey: String(row.day_key),
      assignedCloserId: String(row.assigned_closer_id) as Id<"users">,
      ...(bookingProgramId ? { bookingProgramId } : {}),
      ...(soldProgramId ? { soldProgramId } : {}),
      meetingStatus: String(row.meeting_status) as Doc<"meetings">["status"],
      count: num(row.count),
      ...(meetingId ? { meetingId } : {}),
    };
  });
}

export const pipelineReports = [
  defineReport<typeof getPipelineBacklogAndLoss>({
    id: "pipeline.backlog_and_loss",
    page: "pipeline",
    roles,
    day: "browser",
    parseFilters: noFilters,
    sql: backlogAndLossSql,
    finalize: async (ctx, input) =>
      await buildPipelineBacklogAndLoss(ctx, {
        pendingFollowUps: (input.rows.pending_follow_ups ?? []).map((row) => ({
          type: String(row.type) as Doc<"followUps">["type"],
          createdSource: (str(row.created_source) ?? undefined) as Doc<"followUps">["createdSource"],
        })),
        noShowSources: (input.rows.no_show_sources ?? []).map((row) => ({
          noShowSource: (str(row.no_show_source) ?? undefined) as Doc<"meetings">["noShowSource"],
          count: num(row.count),
        })),
        isNoShowSourceTruncated: false,
        lossCounts: lossCountsFromRows(input.rows.losses),
        isLossAttributionTruncated: false,
      }),
    live: {
      name: "reporting/pipelineHealth:getPipelineBacklogAndLoss",
      args: (input) => ({ startDate: input.range.fromMs, endDate: input.range.toMs }),
    },
  }),
  defineReport<typeof getSchedulingShowRateByOperationsDimensions, ShowRateFilters>({
    id: "pipeline.show_rate",
    page: "pipeline",
    roles,
    // The reader counts business days (the buckets' day keys).
    day: "business",
    parseFilters: parseShowRateFilters,
    sql: showRateSql,
    finalize: async (ctx, input) =>
      await buildSchedulingShowRate(ctx, input.tenantId, input.filters, {
        counts: meetingStatsCounts(input.rows.meeting_counts),
        truncated: false,
      }),
    live: {
      name: "reporting/pipelineHealth:getSchedulingShowRateByOperationsDimensions",
      args: (input) => ({
        startDayKey: input.range.startDate,
        endDayKeyExclusive: addBusinessDays(input.range.endDateInclusive, 1),
        ...(input.filters.bookingProgramId ? { bookingProgramId: input.filters.bookingProgramId } : {}),
        ...(input.filters.attributionTeamId ? { attributionTeamId: input.filters.attributionTeamId } : {}),
        ...(input.filters.dmCloserId ? { dmCloserId: input.filters.dmCloserId } : {}),
      }),
    },
  }),
];
