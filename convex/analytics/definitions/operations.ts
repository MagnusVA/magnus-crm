import type { Id } from "../../_generated/dataModel";
import { addBusinessDays, businessDateForInstant, countBusinessDays } from "../../../lib/businessDay";
import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import {
  buildDmCloserRowsFromCounts,
  type BookedMeetingCounts,
} from "../../dashboard/overviewLeaderboardBuilders";
import type { MeetingStatsCount } from "../../operations/meetingStats";
import {
  buildBookedCallsDashboard,
  type getBookedCallsDashboard,
} from "../../operations/bookedCallsDashboard";
import {
  buildQualificationsDashboard,
  type getQualificationsDashboard,
} from "../../operations/qualificationsDashboard";
import {
  buildSalesCallsDashboard,
  type getSalesCallsDashboard,
} from "../../operations/salesCallsDashboard";
import type { SqlRow } from "../clickhouse";
import {
  defineReport,
  noFilters,
  num,
  rangeParams,
  str,
  type ReportInput,
} from "../definition";
import { docsFromRows } from "../rows";

// Operations dashboards (app/workspace/operations). They run on the tenant
// business day and take an Overview range, so each report maps the resolved
// range back to the business dates and epoch windows deriveOverviewRange
// gives the reader. The meeting buckets, booking credit and qualification
// counts are rebuilt in SQL at the grain each builder reads, and the builders
// do the rest; the readers' row caps don't apply.

type NoFilters = Record<string, never>;

const roles = ["tenant_master", "tenant_admin"] as const;

/** The fields of deriveOverviewRange the builders read, without its 120-day cap. */
function dashboardRange(range: ResolvedAnalyticsRange) {
  return {
    startBusinessDate: range.startDate,
    endBusinessDateInclusive: range.endDateInclusive,
    dayCount: countBusinessDays(range.startDate, addBusinessDays(range.endDateInclusive, 1)),
    slackWindowStart: range.fromMs,
    slackWindowEnd: range.toMs,
    operationsStartDate: range.fromMs,
    operationsEndDate: range.toMs,
  };
}

function liveArgs(input: ReportInput<NoFilters>) {
  return {
    range: {
      kind: "custom",
      startBusinessDate: input.range.startDate,
      endBusinessDateInclusive: input.range.endDateInclusive,
    },
  };
}

// The business date of an instant, as businessDateForInstant computes it.
const businessDateSql = (column: string) =>
  `toDate(toTimeZone(fromUnixTimestamp64Milli(${column}), {tz:String}) - toIntervalHour({day_start_hour:UInt8}))`;

// operationsMeetingStatsV2, rebuilt: one bucket per business day of
// `scheduledAt`, assigned closer, booked program, the deal's sold program and
// meeting status (operations/meetingStats.ts `project`). A meeting whose deal
// is missing has no contribution, hence the inner join.
//
// The builder reads a bucket's day only to tell calls that ended from calls
// still to come (withAttendanceCounts): every scheduled call before
// yesterday has ended. Days before `recent_from` are folded into the range's
// first day, which keeps a two-year range to a few hundred buckets.
export const meetingBucketsSql = `
WITH toString(${businessDateSql("m.scheduled_at_ms")}) AS business_date
SELECT
  if(business_date < {recent_from:String}, {start_date:String}, business_date) AS day_key,
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
GROUP BY day_key, assigned_closer_id, booking_program_id, sold_program_id, meeting_status
ORDER BY day_key, assigned_closer_id, booking_program_id, sold_program_id, meeting_status`;

export function meetingBucketParams(range: ResolvedAnalyticsRange, now: number) {
  const today = businessDateForInstant(now, { timeZone: range.timeZone, dayStartHour: range.dayStartHour });
  // Two days back, so a day can't reach the attendance window between this
  // query and finalize.
  return { ...rangeParams(range), start_date: range.startDate, recent_from: addBusinessDays(today, -2) };
}

// getNonDisputedPaymentsInRange, in its index order.
const paymentsSql = `
SELECT *
FROM analytics.payments
WHERE tenant_id = {tenant_id:String}
  AND recorded_at_ms >= {from_ms:Int64}
  AND recorded_at_ms < {to_ms:Int64}
  AND ifNull(status, '') != 'disputed'
ORDER BY recorded_at_ms, creation_time_ms`;

export function meetingBuckets(rows: SqlRow[] | undefined): MeetingStatsCount[] {
  return (rows ?? []).map((row) => ({
    dayKey: String(row.day_key),
    assignedCloserId: String(row.assigned_closer_id) as Id<"users">,
    bookingProgramId: (str(row.booking_program_id) ?? undefined) as Id<"tenantPrograms"> | undefined,
    soldProgramId: (str(row.sold_program_id) ?? undefined) as Id<"tenantPrograms"> | undefined,
    meetingStatus: String(row.meeting_status) as MeetingStatsCount["meetingStatus"],
    count: num(row.count),
  }));
}

// countBookedMeetings, grouped by credit: first bookings (anything but a
// follow_up) made in the range, with the team and DM closer their booking's
// dm_team and dm_closer rows name (bookingCreditOf, the latest row of each
// role winning). Rows come from the same window as the meetings, as
// bookingCreditsInWindow reads them.
export const bookingCreditCountsSql = `
WITH credits AS (
  SELECT
    meeting_id,
    argMaxIf(team_id, (attributed_at_ms, creation_time_ms), role = 'dm_team') AS credit_team_id,
    argMaxIf(
      nullIf(JSONExtractString(source_json, 'dmCloserId'), ''),
      (attributed_at_ms, creation_time_ms),
      role = 'dm_closer'
    ) AS credit_dm_closer_id
  FROM analytics.attributions
  WHERE tenant_id = {tenant_id:String}
    AND role IN ('dm_team', 'dm_closer')
    AND attributed_at_ms >= {from_ms:Int64}
    AND attributed_at_ms < {to_ms:Int64}
    AND meeting_id IS NOT NULL
    AND JSONExtractString(source_json, 'kind') = 'booking_utm'
  GROUP BY meeting_id
)
SELECT c.credit_team_id AS team_id, c.credit_dm_closer_id AS dm_closer_id, count() AS booked
FROM analytics.meetings AS m
INNER JOIN credits AS c ON c.meeting_id = m.id
WHERE m.tenant_id = {tenant_id:String}
  AND m.created_at_ms >= {from_ms:Int64}
  AND m.created_at_ms < {to_ms:Int64}
  AND ifNull(m.call_classification, '') != 'follow_up'
GROUP BY team_id, dm_closer_id
ORDER BY team_id, dm_closer_id`;

export function bookedMeetingCounts(rows: SqlRow[] | undefined): BookedMeetingCounts {
  const byDmCloser = new Map<Id<"dmClosers">, number>();
  const byAttributionTeam = new Map<Id<"attributionTeams">, number>();
  let teamOnlyBooked = 0;
  for (const row of rows ?? []) {
    const teamId = str(row.team_id) as Id<"attributionTeams"> | null;
    const dmCloserId = str(row.dm_closer_id) as Id<"dmClosers"> | null;
    const booked = num(row.booked);
    if (dmCloserId) byDmCloser.set(dmCloserId, (byDmCloser.get(dmCloserId) ?? 0) + booked);
    if (teamId) {
      byAttributionTeam.set(teamId, (byAttributionTeam.get(teamId) ?? 0) + booked);
      if (!dmCloserId) teamOnlyBooked += booked;
    }
  }
  return { byDmCloser, byAttributionTeam, teamOnlyBooked };
}

// Each opener's events in the range, in the order the reader first meets
// them (by_tenantId_and_submittedAt).
const qualifiedBySlackUserSql = `
SELECT
  slack_user_id,
  count() AS qualified,
  max(submitted_at_ms) AS last_event_at
FROM analytics.qualifications
WHERE tenant_id = {tenant_id:String}
  AND submitted_at_ms >= {from_ms:Int64}
  AND submitted_at_ms < {to_ms:Int64}
GROUP BY slack_user_id
ORDER BY min((submitted_at_ms, creation_time_ms))`;

export const operationsReports = [
  defineReport<typeof getSalesCallsDashboard, NoFilters>({
    id: "sales_calls.dashboard",
    page: "sales_calls",
    roles,
    day: "business",
    parseFilters: noFilters,
    sql: (input) => ({
      buckets: { sql: meetingBucketsSql, params: meetingBucketParams(input.range, Date.now()) },
      payments: { sql: paymentsSql, params: rangeParams(input.range) },
    }),
    finalize: async (ctx, input) =>
      await buildSalesCallsDashboard(ctx, input.tenantId, dashboardRange(input.range), {
        statsRows: meetingBuckets(input.rows.buckets),
        statsCapped: false,
        paymentScan: { payments: docsFromRows<"paymentRecords">(input.rows.payments), isTruncated: false },
      }),
    live: { name: "operations/salesCallsDashboard:getSalesCallsDashboard", args: liveArgs },
  }),
  defineReport<typeof getBookedCallsDashboard, NoFilters>({
    id: "booked_calls.dashboard",
    page: "booked_calls",
    roles,
    day: "business",
    parseFilters: noFilters,
    sql: (input) => ({
      bookings: { sql: bookingCreditCountsSql, params: rangeParams(input.range) },
    }),
    finalize: async (ctx, input) => {
      const range = dashboardRange(input.range);
      const dmClosers = await buildDmCloserRowsFromCounts(
        ctx,
        { tenantId: input.tenantId, range, includeAllCandidates: false },
        bookedMeetingCounts(input.rows.bookings),
      );
      return await buildBookedCallsDashboard(ctx, input.tenantId, range, dmClosers);
    },
    live: { name: "operations/bookedCallsDashboard:getBookedCallsDashboard", args: liveArgs },
  }),
  defineReport<typeof getQualificationsDashboard, NoFilters>({
    id: "qualifications.dashboard",
    page: "qualifications",
    roles,
    day: "business",
    parseFilters: noFilters,
    sql: (input) => ({
      openers: { sql: qualifiedBySlackUserSql, params: rangeParams(input.range) },
    }),
    finalize: async (ctx, input) => {
      const tenant = await ctx.db.get("tenants", input.tenantId);
      if (!tenant) throw new Error("Tenant not found.");
      return await buildQualificationsDashboard(ctx, tenant, dashboardRange(input.range), {
        bySlackUser: (input.rows.openers ?? []).map((row) => ({
          slackUserId: String(row.slack_user_id),
          qualified: num(row.qualified),
          lastEventAt: num(row.last_event_at),
        })),
        truncated: false,
      });
    },
    live: { name: "operations/qualificationsDashboard:getQualificationsDashboard", args: liveArgs },
  }),
];
