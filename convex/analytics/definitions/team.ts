import type { Id } from "../../_generated/dataModel";
import { addBusinessDays, businessDateForInstant } from "../../../lib/businessDay";
import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import type { MeetingStatsCount } from "../../operations/meetingStats";
import { buildActionsPerCloserPerDay, type getActionsPerCloserPerDay } from "../../reporting/teamActions";
import {
  buildTeamOutcomeMix,
  type getTeamOutcomeMix,
  type TeamMeetingOutcome,
} from "../../reporting/teamOutcomes";
import {
  buildTeamOperationsDimensions,
  buildTeamPerformanceMetrics,
  type getTeamOperationsDimensions,
  type getTeamPerformanceMetrics,
  type TeamMeetingCounter,
} from "../../reporting/teamPerformance";
import { deriveCallOutcomeByStage } from "../../reporting/lib/outcomeDerivation";
import type { SqlRow } from "../clickhouse";
import { closeRateCohortCounts, closeRateCohortSql } from "./closeRateCohort";
import {
  defineReport,
  noFilters,
  num,
  optionalIdFilter,
  rangeParams,
  str,
  type ReportInput,
} from "../definition";
import { docsFromRows } from "../rows";

// Team Performance (app/workspace/reports/team). The page queries tenant
// business days, so every report here does too. The meetingsByStatus counts,
// the operationsMeetingStatsV2 buckets, each meeting's outcome inputs and the
// closer action counts are rebuilt in SQL at the grain each builder reads;
// payments come back as rows, and the close rate cohort as counts by closer
// and booked program (closeRateCohort.ts). The builders do the rest, and the readers' scan
// caps don't apply.

type NoFilters = Record<string, never>;

type OperationsFilters = {
  bookingProgramId: Id<"tenantPrograms"> | null;
  attributionTeamId: Id<"attributionTeams"> | null;
  dmCloserId: Id<"dmClosers"> | null;
};

const roles = ["tenant_master", "tenant_admin"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

function rangeArgs(input: ReportInput<NoFilters>) {
  return { startDate: input.range.fromMs, endDate: input.range.toMs };
}

// The business date of an instant, as businessDateForInstant computes it.
const businessDateSql = (column: string) =>
  `toDate(toTimeZone(fromUnixTimestamp64Milli(${column}), {tz:String}) - toIntervalHour({day_start_hour:UInt8}))`;

// getNonDisputedPaymentsInRange, in its index order.
const paymentsSql = `
SELECT *
FROM analytics.payments
WHERE tenant_id = {tenant_id:String}
  AND recorded_at_ms >= {from_ms:Int64}
  AND recorded_at_ms < {to_ms:Int64}
  AND ifNull(status, '') != 'disputed'
ORDER BY recorded_at_ms, creation_time_ms`;

// ---------------------------------------------------------------------------
// Metrics: the meetingsByStatus aggregate
// ---------------------------------------------------------------------------

// meetingsByStatus, rebuilt: meetings by closer, classification, status and
// `scheduledAt`, the aggregate's key. The builder counts a key over the whole
// range, and its scheduled meetings again up to the attendance window, which
// starts at least a day before now. So only a scheduled meeting from the last
// two days keeps its time; every other meeting is folded into the range's
// start.
const meetingCountsSql = `
SELECT
  assigned_closer_id AS closer_id,
  ifNull(call_classification, 'new') AS classification,
  status AS meeting_status,
  if(status = 'scheduled' AND scheduled_at_ms >= {recent_from_ms:Int64}, scheduled_at_ms, {from_ms:Int64}) AS at_ms,
  count() AS count
FROM analytics.meetings
WHERE tenant_id = {tenant_id:String}
  AND scheduled_at_ms >= {from_ms:Int64}
  AND scheduled_at_ms < {to_ms:Int64}
GROUP BY closer_id, classification, meeting_status, at_ms
ORDER BY closer_id, classification, meeting_status, at_ms`;

/** meetingsByStatus.countBatch over the rows of `meetingCountsSql`. */
function meetingCounter(rows: SqlRow[] | undefined): TeamMeetingCounter {
  const byKey = new Map<string, Array<{ at: number; count: number }>>();
  for (const row of rows ?? []) {
    const key = JSON.stringify([String(row.closer_id), String(row.classification), String(row.meeting_status)]);
    const list = byKey.get(key) ?? [];
    list.push({ at: num(row.at_ms), count: num(row.count) });
    byKey.set(key, list);
  }
  return async (keys, startDate, endDate) =>
    keys.map((key) =>
      (byKey.get(JSON.stringify([key.closerId, key.classification, key.status])) ?? [])
        .filter((bucket) => bucket.at >= startDate && bucket.at < endDate)
        .reduce((sum, bucket) => sum + bucket.count, 0),
    );
}

// ---------------------------------------------------------------------------
// Operations dimensions: the operationsMeetingStatsV2 buckets
// ---------------------------------------------------------------------------

// The meetings a team or DM closer filter credits (operations/meetingStats.ts
// `creditedMeetingIds`): a DM closer's booking rows are found by its team
// member and kept to that record; with a team too, the meeting needs a
// dm_team row for it as well.
const teamCreditSql = `
SELECT meeting_id
FROM analytics.attributions
WHERE tenant_id = {tenant_id:String}
  AND role = 'dm_team'
  AND team_id = {attribution_team_id:String}
  AND meeting_scheduled_at_ms >= {from_ms:Int64}
  AND meeting_scheduled_at_ms < {to_ms:Int64}
  AND meeting_id IS NOT NULL`;

const dmCloserCreditSql = `
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

// operationsMeetingStatsV2, rebuilt as convex/analytics/definitions/operations.ts
// does: one bucket per business day of `scheduledAt`, assigned closer, booked
// program, the deal's sold program and status, days before `recent_from`
// folded into the range's first day. With a team or DM closer, the reader
// counts each credited meeting on its own, so a recent day keeps the meeting
// id withAttendanceCounts splits by; folded days need none.
function meetingBucketsSql(filters: OperationsFilters) {
  const credited = [
    filters.attributionTeamId ? `AND m.id IN (${teamCreditSql})` : "",
    filters.dmCloserId ? `AND m.id IN (${dmCloserCreditSql})` : "",
  ].filter(Boolean);
  const meetingId = credited.length > 0
    ? "if(business_date < {recent_from:String}, NULL, m.id)"
    : "CAST(NULL AS Nullable(String))";
  return `
WITH toString(${businessDateSql("m.scheduled_at_ms")}) AS business_date
SELECT
  if(business_date < {recent_from:String}, {start_date:String}, business_date) AS day_key,
  ${meetingId} AS meeting_id,
  m.assigned_closer_id AS assigned_closer_id,
  m.booking_program_id AS booking_program_id,
  d.sold_program_id AS sold_program_id,
  m.status AS meeting_status,
  count() AS count
FROM analytics.meetings AS m
INNER JOIN (
  SELECT id, sold_program_id
  FROM analytics.deals
  WHERE tenant_id = {tenant_id:String}
) AS d ON d.id = m.opportunity_id
WHERE m.tenant_id = {tenant_id:String}
  AND m.scheduled_at_ms >= {from_ms:Int64}
  AND m.scheduled_at_ms < {to_ms:Int64}
  ${credited.join("\n  ")}
GROUP BY day_key, meeting_id, assigned_closer_id, booking_program_id, sold_program_id, meeting_status
ORDER BY day_key, meeting_id, assigned_closer_id, booking_program_id, sold_program_id, meeting_status`;
}

function meetingBucketParams(range: ResolvedAnalyticsRange, filters: OperationsFilters, now: number) {
  const today = businessDateForInstant(now, { timeZone: range.timeZone, dayStartHour: range.dayStartHour });
  return {
    ...rangeParams(range),
    start_date: range.startDate,
    // Two days back, so a day can't reach the attendance window between this
    // query and finalize.
    recent_from: addBusinessDays(today, -2),
    ...(filters.attributionTeamId ? { attribution_team_id: filters.attributionTeamId } : {}),
    ...(filters.dmCloserId ? { dm_closer_id: filters.dmCloserId } : {}),
  };
}

function meetingBuckets(rows: SqlRow[] | undefined): MeetingStatsCount[] {
  return (rows ?? []).map((row) => {
    const meetingId = str(row.meeting_id) as Id<"meetings"> | null;
    return {
      dayKey: String(row.day_key),
      ...(meetingId ? { meetingId } : {}),
      assignedCloserId: String(row.assigned_closer_id) as Id<"users">,
      bookingProgramId: (str(row.booking_program_id) ?? undefined) as Id<"tenantPrograms"> | undefined,
      soldProgramId: (str(row.sold_program_id) ?? undefined) as Id<"tenantPrograms"> | undefined,
      meetingStatus: String(row.meeting_status) as MeetingStatsCount["meetingStatus"],
      count: num(row.count),
    };
  });
}

// ---------------------------------------------------------------------------
// Outcome mix: each meeting's outcome inputs
// ---------------------------------------------------------------------------

// What deriveCallOutcomeByStage reads of each meeting scheduled in the range
// (readTeamOutcomeInputs, meetingOutcomesByStage): its deal's stage, outcome
// and loss, whether the meeting is the deal's latest, whether the deal was paid
// in the range, whether a meeting in the range reschedules it, and whether the
// deal has a pending reschedule link. A meeting whose deal is missing has no
// outcome, hence the inner join. Meetings with the same inputs are counted
// together. The chart splits scheduled meetings by whether they have ended, so
// one that hasn't ended by now keeps its end time; the rest fold to 0.
const meetingOutcomesSql = `
SELECT
  m.assigned_closer_id AS closer_id,
  m.status AS meeting_status,
  if(
    m.status = 'scheduled' AND m.scheduled_at_ms + toInt64(m.duration_minutes * 60000) > {now_ms:Int64},
    m.scheduled_at_ms + toInt64(m.duration_minutes * 60000),
    0
  ) AS ends_at_ms,
  d.source AS deal_source,
  d.stage AS deal_stage,
  d.outcome AS deal_outcome,
  d.lost_reason AS lost_reason,
  d.lost_by_user_id IS NOT NULL AS lost_by_person,
  ifNull(d.latest_meeting_id = m.id, 0) AS is_latest_meeting,
  m.opportunity_id IN (
    SELECT opportunity_id
    FROM analytics.payments
    WHERE tenant_id = {tenant_id:String}
      AND recorded_at_ms >= {from_ms:Int64}
      AND recorded_at_ms < {to_ms:Int64}
      AND ifNull(status, '') != 'disputed'
      AND opportunity_id IS NOT NULL
  ) AS has_payment,
  m.id IN (
    SELECT rescheduled_from_meeting_id
    FROM analytics.meetings
    WHERE tenant_id = {tenant_id:String}
      AND scheduled_at_ms >= {from_ms:Int64}
      AND scheduled_at_ms < {to_ms:Int64}
      AND rescheduled_from_meeting_id IS NOT NULL
  ) AS is_rescheduled,
  m.opportunity_id IN (
    SELECT opportunity_id
    FROM analytics.followups
    WHERE tenant_id = {tenant_id:String}
      AND status = 'pending'
      AND reason = 'no_show_follow_up'
      AND type = 'scheduling_link'
      AND opportunity_id IS NOT NULL
  ) AS has_reschedule_link,
  count() AS count
FROM analytics.meetings AS m
INNER JOIN (
  SELECT id, source, stage, outcome, lost_reason, lost_by_user_id, latest_meeting_id
  FROM analytics.deals
  WHERE tenant_id = {tenant_id:String}
) AS d ON d.id = m.opportunity_id
WHERE m.tenant_id = {tenant_id:String}
  AND m.scheduled_at_ms >= {from_ms:Int64}
  AND m.scheduled_at_ms < {to_ms:Int64}
GROUP BY closer_id, meeting_status, ends_at_ms, deal_source, deal_stage, deal_outcome, lost_reason,
  lost_by_person, is_latest_meeting, has_payment, is_rescheduled, has_reschedule_link
ORDER BY closer_id, meeting_status, ends_at_ms`;

// Stand-ins for the ids the derivation compares: the meeting and its deal's
// latest meeting, and the person who closed the deal lost.
const MEETING = "meeting" as Id<"meetings">;
const PERSON = "person" as Id<"users">;

function flag(value: unknown) {
  return value === true || num(value) !== 0;
}

/** Each meeting's outcome, from the rows of `meetingOutcomesSql`. */
function meetingOutcomes(rows: SqlRow[] | undefined): TeamMeetingOutcome[] {
  const outcomes: TeamMeetingOutcome[] = [];
  for (const row of rows ?? []) {
    const meeting = {
      _id: MEETING,
      assignedCloserId: String(row.closer_id) as Id<"users">,
      status: String(row.meeting_status) as TeamMeetingOutcome["meeting"]["status"],
      // The end time stands in for the start, so the meeting ends when it did.
      scheduledAt: num(row.ends_at_ms),
      durationMinutes: 0,
    };
    type Deal = Parameters<typeof deriveCallOutcomeByStage>[1];
    const deal: Deal = {
      source: String(row.deal_source) as Deal["source"],
      stage: String(row.deal_stage) as Deal["stage"],
      outcome: String(row.deal_outcome) as Deal["outcome"],
      lostReason: str(row.lost_reason) ?? undefined,
      lostByUserId: flag(row.lost_by_person) ? PERSON : undefined,
      latestMeetingId: flag(row.is_latest_meeting) ? MEETING : undefined,
    };
    const outcome = deriveCallOutcomeByStage(
      meeting,
      deal,
      flag(row.has_payment),
      flag(row.is_rescheduled),
      flag(row.has_reschedule_link),
    );
    for (let index = 0; index < num(row.count); index += 1) {
      outcomes.push({ meeting, outcome });
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Actions: closer domain events
// ---------------------------------------------------------------------------

// Each closer's actions in the range, in the order the reader first meets
// them (by_tenantId_and_source_and_occurredAt).
const closerActionsSql = `
SELECT actor_user_id, count() AS actions
FROM analytics.events
WHERE tenant_id = {tenant_id:String}
  AND source = 'closer'
  AND occurred_at_ms >= {from_ms:Int64}
  AND occurred_at_ms < {to_ms:Int64}
  AND actor_user_id IS NOT NULL
GROUP BY actor_user_id
ORDER BY min((occurred_at_ms, creation_time_ms))`;

export const teamReports = [
  defineReport<typeof getTeamPerformanceMetrics, NoFilters>({
    id: "team.metrics",
    page: "team",
    roles,
    day: "business",
    parseFilters: noFilters,
    sql: (input) => ({
      meetings: {
        sql: meetingCountsSql,
        params: { ...rangeParams(input.range), recent_from_ms: Date.now() - 2 * DAY_MS },
      },
      payments: { sql: paymentsSql, params: rangeParams(input.range) },
      closeRate: { sql: closeRateCohortSql, params: rangeParams(input.range) },
    }),
    finalize: async (ctx, input) =>
      await buildTeamPerformanceMetrics(ctx, input.tenantId, rangeArgs(input), {
        countMeetings: meetingCounter(input.rows.meetings),
        paymentScan: { payments: docsFromRows<"paymentRecords">(input.rows.payments), isTruncated: false },
        closeRateCohort: { counts: closeRateCohortCounts(input.rows.closeRate), capped: false },
      }),
    live: { name: "reporting/teamPerformance:getTeamPerformanceMetrics", args: rangeArgs },
  }),
  defineReport<typeof getTeamOperationsDimensions, OperationsFilters>({
    id: "team.operations",
    page: "team",
    roles,
    day: "business",
    parseFilters: async (ctx, raw) => ({
      bookingProgramId: optionalIdFilter(ctx, "tenantPrograms", raw.bookingProgramId),
      attributionTeamId: optionalIdFilter(ctx, "attributionTeams", raw.attributionTeamId),
      dmCloserId: optionalIdFilter(ctx, "dmClosers", raw.dmCloserId),
    }),
    sql: (input) => ({
      buckets: {
        sql: meetingBucketsSql(input.filters),
        params: meetingBucketParams(input.range, input.filters, Date.now()),
      },
    }),
    finalize: async (ctx, input) =>
      await buildTeamOperationsDimensions(ctx, input.tenantId, input.filters, {
        counts: meetingBuckets(input.rows.buckets),
        truncated: false,
      }),
    live: {
      name: "reporting/teamPerformance:getTeamOperationsDimensions",
      args: (input) => ({
        startDayKey: input.range.startDate,
        endDayKeyExclusive: addBusinessDays(input.range.endDateInclusive, 1),
        ...(input.filters.bookingProgramId ? { bookingProgramId: input.filters.bookingProgramId } : {}),
        ...(input.filters.attributionTeamId ? { attributionTeamId: input.filters.attributionTeamId } : {}),
        ...(input.filters.dmCloserId ? { dmCloserId: input.filters.dmCloserId } : {}),
      }),
    },
  }),
  defineReport<typeof getTeamOutcomeMix, NoFilters>({
    id: "team.outcomes",
    page: "team",
    roles,
    day: "business",
    parseFilters: noFilters,
    sql: (input) => ({
      outcomes: { sql: meetingOutcomesSql, params: { ...rangeParams(input.range), now_ms: Date.now() } },
    }),
    finalize: async (ctx, input) =>
      await buildTeamOutcomeMix(ctx, input.tenantId, meetingOutcomes(input.rows.outcomes), false),
    live: { name: "reporting/teamOutcomes:getTeamOutcomeMix", args: rangeArgs },
  }),
  defineReport<typeof getActionsPerCloserPerDay, NoFilters>({
    id: "team.actions",
    page: "team",
    roles,
    day: "business",
    parseFilters: noFilters,
    sql: (input) => ({
      actions: { sql: closerActionsSql, params: rangeParams(input.range) },
    }),
    finalize: async (ctx, input) =>
      await buildActionsPerCloserPerDay(ctx, rangeArgs(input), {
        closerActions: new Map(
          (input.rows.actions ?? []).map((row) => [String(row.actor_user_id) as Id<"users">, num(row.actions)]),
        ),
        isTruncated: false,
      }),
    live: { name: "reporting/teamActions:getActionsPerCloserPerDay", args: rangeArgs },
  }),
];
