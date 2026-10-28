import type { QueryCtx } from "../../_generated/server";
import type { getOverviewDashboard } from "../../dashboard/overview";
import { buildOverviewDashboard } from "../../dashboard/overviewBuilders";
import {
  buildDmCloserRowsFromCounts,
  buildExpandedOverviewLeaderboardFromRows,
  buildLeadGenEfficiencyRowsFromDaily,
  buildQualifierRowsFromActivity,
  type QualifierActivity,
} from "../../dashboard/overviewLeaderboardBuilders";
import type { listOverviewLeaderboardRows } from "../../dashboard/overviewLeaderboards";
import { buildLeadGenOverviewSection } from "../../dashboard/overviewLeadGen";
import {
  buildPhoneCloserOperationsOverviewSection,
  buildTopDmClosersOverviewSection,
} from "../../dashboard/overviewOperations";
import { buildTopOriginsOverviewSection } from "../../dashboard/overviewOrigins";
import type { DerivedOverviewRange } from "../../dashboard/overviewRange";
import { buildTopQualifiersOverviewSection } from "../../dashboard/overviewSlack";
import type { LeaderboardFilters, OverviewLeaderboardKind } from "../../dashboard/overviewTypes";
import { TOP_OVERVIEW_ORIGIN_LIMIT } from "../../leadGen/reportLimits";
import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import type { SqlQuery, SqlRow } from "../clickhouse";
import {
  defineReport,
  noFilters,
  num,
  optionalEnumFilter,
  rangeParams,
  type AnalyticsFilters,
  type ReportInput,
} from "../definition";
import { publicRange } from "./leadGenDaily";
import { ORIGIN_CAPTURES } from "./leadGenOrigins";
import { dailyStatRows, dailyStatsSql, RANGE_CAPTURES, VOIDED_CAPTURES, type LeadGenSource } from "./leadGenShared";
import {
  bookedMeetingCounts,
  bookingCreditCountsSql,
  meetingBucketParams,
  meetingBuckets,
  meetingBucketsSql,
} from "./operations";

// Overview (app/workspace/page.tsx) and its expanded leaderboards. They run on
// the tenant business day and take an Overview range. The SQL rebuilds what
// each section reads, reusing the lead gen and Operations ports: the
// `leadGenDailyStats` rows, the per-origin totals of `leadGenOriginStats`, the
// `operationsMeetingStatsV2` buckets and the first-booking credit counts. The
// qualifier rows count each opener's events and booked Slack deals, and the
// Slack-sourced deals the slackQualificationsByUser aggregate indexes. The
// section builders do the rest, and the readers' row caps don't apply.
//
// The readers mark a section rebuilding, or fail it, while the tenant's Convex
// buckets are rebuilt after a business-day change. ClickHouse reads the
// source rows, so those gates stay on the Convex path, as on Operations and
// lead gen.

const roles = ["tenant_master", "tenant_admin"] as const;

/** deriveOverviewRange for a resolved custom range, without its 120-day cap. */
function overviewRange(range: ResolvedAnalyticsRange): DerivedOverviewRange {
  const dates = publicRange(range);
  return {
    ...dates,
    input: {
      kind: "custom",
      startBusinessDate: range.startDate,
      endBusinessDateInclusive: range.endDateInclusive,
    },
    slackWindowStart: range.fromMs,
    slackWindowEnd: range.toMs,
    operationsStartDate: range.fromMs,
    operationsEndDate: range.toMs,
    operationsStartDayKey: range.startDate,
    operationsEndDayKeyExclusive: dates.endBusinessDateExclusive,
  };
}

function liveRange(range: ResolvedAnalyticsRange) {
  return {
    kind: "custom",
    startBusinessDate: range.startDate,
    endBusinessDateInclusive: range.endDateInclusive,
  };
}

/**
 * Top posts and reels: `leadGenOriginStats` summed per source and origin, as
 * leadGenOrigins.ts sums them for the unfiltered Lead Gen panel. The builder
 * ranks by submissions, then unique prospects, then value, so the SQL keeps
 * every origin that ties into the top ten, in the order the reader first
 * meets them.
 */
function topOriginsSql(range: ResolvedAnalyticsRange): SqlQuery {
  return {
    sql: `
WITH${VOIDED_CAPTURES},${RANGE_CAPTURES},${ORIGIN_CAPTURES},
origin_days AS (
  SELECT
    origin_key,
    day_key,
    argMin(source, (submitted_at_ms, creation_time_ms)) AS day_source,
    argMin(origin_kind, (submitted_at_ms, creation_time_ms)) AS day_kind,
    argMin(origin_value, (submitted_at_ms, creation_time_ms)) AS day_value,
    min((submitted_at_ms, creation_time_ms)) AS first_at,
    countIf(active) AS day_submissions,
    uniqExactIf(prospect_id, active) AS day_unique_prospects
  FROM origin_captures
  GROUP BY origin_key, day_key
),
origins AS (
  SELECT
    day_source AS source,
    origin_key,
    argMin(day_kind, (day_key, first_at)) AS first_kind,
    argMin(day_value, (day_key, first_at)) AS first_value,
    sum(day_submissions) AS submissions,
    sum(day_unique_prospects) AS unique_prospects,
    min((day_key, first_at)) AS first_seen
  FROM origin_days
  GROUP BY day_source, origin_key
)
SELECT source, origin_key, first_kind, first_value, submissions, unique_prospects
FROM (
  SELECT *, rank() OVER (ORDER BY submissions DESC, unique_prospects DESC) AS origin_rank
  FROM origins
)
WHERE origin_rank <= {limit:UInt32}
ORDER BY first_seen`,
    params: { ...rangeParams(range), limit: TOP_OVERVIEW_ORIGIN_LIMIT },
  };
}

function originRows(rows: SqlRow[] | undefined) {
  return (rows ?? []).map((row) => ({
    source: String(row.source) as LeadGenSource,
    originKey: String(row.origin_key),
    originKind: String(row.first_kind) as "post" | "reel",
    originValue: String(row.first_value),
    submissions: num(row.submissions),
    uniqueProspectsSubmitted: num(row.unique_prospects),
  }));
}

/**
 * Each opener's events in the range and the Slack-sourced deals among them
 * with a meeting, in the order the reader first meets the opener
 * (by_tenantId_and_submittedAt).
 */
function qualifierEventsSql(range: ResolvedAnalyticsRange): SqlQuery {
  return {
    sql: `
SELECT
  slack_user_id,
  count() AS total,
  uniqExactIf(
    opportunity_id,
    opportunity_id IS NOT NULL AND opportunity_id IN (
      SELECT id
      FROM analytics.deals
      WHERE tenant_id = {tenant_id:String}
        AND source = 'slack_qualified'
        AND ifNull(latest_meeting_id, '') != ''
    )
  ) AS booked
FROM analytics.qualifications
WHERE tenant_id = {tenant_id:String}
  AND submitted_at_ms >= {from_ms:Int64}
  AND submitted_at_ms < {to_ms:Int64}
GROUP BY slack_user_id
ORDER BY min((submitted_at_ms, creation_time_ms))`,
    params: rangeParams(range),
  };
}

/**
 * The slackQualificationsByUser counts: Slack-sourced deals with a qualifier,
 * by the qualifier and its submission time, as slackQualifications.ts counts
 * the legacy aggregate.
 */
function qualifiedDealsSql(range: ResolvedAnalyticsRange): SqlQuery {
  return {
    sql: `
SELECT
  JSONExtractString(qualified_by_json, 'slackUserId') AS slack_user_id,
  count() AS qualified
FROM analytics.deals
WHERE tenant_id = {tenant_id:String}
  AND source = 'slack_qualified'
  AND JSONHas(ifNull(qualified_by_json, '{}'), 'submittedAt')
  AND JSONExtractFloat(qualified_by_json, 'submittedAt') >= {from_ms:Int64}
  AND JSONExtractFloat(qualified_by_json, 'submittedAt') < {to_ms:Int64}
GROUP BY slack_user_id`,
    params: rangeParams(range),
  };
}

function qualifierActivity(rows: Record<string, SqlRow[]>): QualifierActivity {
  const qualified = new Map(
    (rows.qualified ?? []).map((row) => [String(row.slack_user_id), num(row.qualified)]),
  );
  return {
    bySlackUserId: new Map(
      (rows.qualifiers ?? []).map((row) => [
        String(row.slack_user_id),
        { total: num(row.total), booked: num(row.booked) },
      ]),
    ),
    truncated: false,
    countQualified: async (slackUserId) => qualified.get(slackUserId) ?? 0,
  };
}

const bookingsSql = (range: ResolvedAnalyticsRange): SqlQuery => ({
  sql: bookingCreditCountsSql,
  params: rangeParams(range),
});

type LeaderboardReportFilters = {
  kind: OverviewLeaderboardKind;
  search: string | null;
  schedule: NonNullable<LeaderboardFilters["schedule"]> | null;
  activity: NonNullable<LeaderboardFilters["activity"]> | null;
};

const MAX_SEARCH_LENGTH = 100;

async function parseLeaderboardFilters(
  _ctx: QueryCtx,
  raw: AnalyticsFilters,
): Promise<LeaderboardReportFilters> {
  const kind = optionalEnumFilter(raw.kind, ["lead_gen", "qualifiers", "dm_closers"] as const);
  if (!kind) throw new Error("Invalid filter.");
  if (raw.search !== undefined && raw.search !== null && typeof raw.search !== "string") {
    throw new Error("Invalid filter.");
  }
  // The builder trims and lower-cases the search, so equal searches share a key.
  const search = typeof raw.search === "string" ? raw.search.trim().toLowerCase() : "";
  if (search.length > MAX_SEARCH_LENGTH) throw new Error("Invalid filter.");
  return {
    kind,
    search: search === "" ? null : search,
    schedule: optionalEnumFilter(raw.schedule, ["all", "scheduled", "unscheduled"] as const),
    activity: optionalEnumFilter(raw.activity, ["all", "with_activity", "without_activity"] as const),
  };
}

function leaderboardFilters(filters: LeaderboardReportFilters): LeaderboardFilters {
  return {
    ...(filters.search !== null ? { search: filters.search } : {}),
    ...(filters.schedule !== null ? { schedule: filters.schedule } : {}),
    ...(filters.activity !== null ? { activity: filters.activity } : {}),
  };
}

export const overviewReports = [
  defineReport<typeof getOverviewDashboard>({
    id: "overview.dashboard",
    page: "overview",
    roles,
    day: "business",
    parseFilters: noFilters,
    sql: (input) => ({
      daily: dailyStatsSql(input.range, {}),
      origins: topOriginsSql(input.range),
      qualifiers: qualifierEventsSql(input.range),
      qualified: qualifiedDealsSql(input.range),
      bookings: bookingsSql(input.range),
      buckets: { sql: meetingBucketsSql, params: meetingBucketParams(input.range, Date.now()) },
    }),
    finalize: async (ctx, input) => {
      const { tenantId } = input;
      const range = overviewRange(input.range);
      return await buildOverviewDashboard(
        range,
        {
          leadGen: () => buildLeadGenOverviewSection(ctx, tenantId, range, dailyStatRows(input.rows.daily)),
          topQualifiers: () =>
            buildTopQualifiersOverviewSection(ctx, tenantId, range, qualifierActivity(input.rows)),
          topDmClosers: async () =>
            buildTopDmClosersOverviewSection(
              await buildDmCloserRowsFromCounts(
                ctx,
                { tenantId, range, includeAllCandidates: false },
                bookedMeetingCounts(input.rows.bookings),
              ),
            ),
          phoneCloserOperations: () =>
            buildPhoneCloserOperationsOverviewSection(ctx, tenantId, meetingBuckets(input.rows.buckets)),
          topOrigins: async () => buildTopOriginsOverviewSection(originRows(input.rows.origins)),
        },
        { leadGen: false, meetings: false },
      );
    },
    live: {
      name: "dashboard/overview:getOverviewDashboard",
      args: (input) => ({ range: liveRange(input.range) }),
    },
  }),
  defineReport<typeof listOverviewLeaderboardRows, LeaderboardReportFilters>({
    id: "overview.leaderboard",
    page: "overview",
    roles,
    day: "business",
    parseFilters: parseLeaderboardFilters,
    // Only the leaderboard's own rows.
    sql: (input): Record<string, SqlQuery> => {
      switch (input.filters.kind) {
        case "lead_gen":
          return { daily: dailyStatsSql(input.range, {}) };
        case "qualifiers":
          return { qualifiers: qualifierEventsSql(input.range), qualified: qualifiedDealsSql(input.range) };
        case "dm_closers":
          return { bookings: bookingsSql(input.range) };
      }
    },
    finalize: async (ctx, input) => {
      const candidates = {
        tenantId: input.tenantId,
        range: overviewRange(input.range),
        includeAllCandidates: true,
      };
      return await buildExpandedOverviewLeaderboardFromRows(
        ctx,
        { tenantId: input.tenantId, kind: input.filters.kind, filters: leaderboardFilters(input.filters) },
        {
          leadGen: () => buildLeadGenEfficiencyRowsFromDaily(ctx, candidates, dailyStatRows(input.rows.daily)),
          qualifiers: () => buildQualifierRowsFromActivity(ctx, candidates, qualifierActivity(input.rows)),
          dmClosers: () => buildDmCloserRowsFromCounts(ctx, candidates, bookedMeetingCounts(input.rows.bookings)),
        },
      );
    },
    live: {
      name: "dashboard/overviewLeaderboards:listOverviewLeaderboardRows",
      args: (input: ReportInput<LeaderboardReportFilters>) => {
        const filters = leaderboardFilters(input.filters);
        return {
          kind: input.filters.kind,
          range: liveRange(input.range),
          ...(Object.keys(filters).length > 0 ? { filters } : {}),
        };
      },
    },
  }),
];
