import type { Id } from "../../_generated/dataModel";
import {
  buildTopOrigins,
  buildTopOriginsByTeam,
  type listTopOrigins,
  type listTopOriginsByTeam,
  type TopOriginTeamGroup,
} from "../../leadGen/reporting";
import { MAX_TOP_ORIGINS, MAX_TOP_ORIGINS_PER_TEAM } from "../../leadGen/reportLimits";
import type { SqlRow } from "../clickhouse";
import {
  defineReport,
  num,
  optionalEnumFilter,
  rangeParams,
  str,
  type AnalyticsFilterValue,
  type ReportInput,
} from "../definition";
import {
  captureFilterSql,
  leadGenLiveArgs,
  parseLeadGenFilters,
  RANGE_CAPTURES,
  VOIDED_CAPTURES,
  type LeadGenReportFilters,
  type LeadGenSource,
} from "./leadGenShared";

// Top posts and reels. Over a long range the origin buckets run to tens of
// thousands of rows, past what a report may hand to `finalize`, so the SQL
// totals them per origin, as the readers' loops do, and returns only what
// the builders rank: the top origins, in the order the reader first meets
// them, which breaks ties.
//
// A stored post or reel origin is already normalized, so its key is the
// lower-cased value (`normalizeLeadGenOrigin`).

const roles = ["tenant_master", "tenant_admin"] as const;

export const ORIGIN_CAPTURES = `
origin_captures AS (
  SELECT *, lowerUTF8(assumeNotNull(origin_value)) AS origin_key
  FROM range_captures
  WHERE origin_rankable
    AND origin_kind IN ('post', 'reel')
    AND ifNull(origin_value, '') != ''
)`;

function limitFilter(raw: AnalyticsFilterValue | undefined, max: number) {
  if (raw === undefined || raw === null || raw === "") return max;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > max) {
    throw new Error(`Limit must be an integer between 1 and ${max}`);
  }
  return raw;
}

type TopOriginsFilters = LeadGenReportFilters & { limit: number };

/**
 * `listTopOrigins`. With no team or worker the reader sums the
 * `leadGenOriginStats` rows: one per origin and day, whose source is that
 * day's first capture's, kept even when every capture was voided. With
 * either it reads the active captures.
 */
function topOriginsSql(input: ReportInput<TopOriginsFilters>) {
  const { teamId, workerId, source, limit } = input.filters;
  const params = { ...rangeParams(input.range), limit };
  if (teamId || workerId) {
    const filter = captureFilterSql({ teamId, workerId, source });
    return {
      origins: {
        sql: `
WITH${VOIDED_CAPTURES},${RANGE_CAPTURES},${ORIGIN_CAPTURES}
SELECT
  source,
  origin_key,
  argMin(origin_kind, (submitted_at_ms, creation_time_ms)) AS first_kind,
  argMin(origin_value, (submitted_at_ms, creation_time_ms)) AS first_value,
  count() AS submission_count,
  uniqExact((prospect_id, day_key)) AS unique_prospects,
  uniqExact(day_key) AS day_count
FROM origin_captures
WHERE active ${filter.where}
GROUP BY source, origin_key
ORDER BY submission_count DESC, min((submitted_at_ms, creation_time_ms))
LIMIT {limit:UInt32}`,
        params: { ...params, ...filter.params },
      },
    };
  }
  return {
    origins: {
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
)
SELECT
  day_source AS source,
  origin_key,
  argMin(day_kind, (day_key, first_at)) AS first_kind,
  argMin(day_value, (day_key, first_at)) AS first_value,
  sum(day_submissions) AS submission_count,
  sum(day_unique_prospects) AS unique_prospects,
  count() AS day_count
FROM origin_days
WHERE 1 ${source ? "AND day_source = {source:String}" : ""}
GROUP BY day_source, origin_key
ORDER BY submission_count DESC, min((day_key, first_at))
LIMIT {limit:UInt32}`,
      params: { ...params, ...(source ? { source } : {}) },
    },
  };
}

function originFields(row: SqlRow) {
  return {
    originKey: String(row.origin_key),
    source: String(row.source) as LeadGenSource,
    originKind: String(row.first_kind) as "post" | "reel",
    originValue: String(row.first_value),
    uniqueProspects: num(row.unique_prospects),
    submissions: num(row.submission_count),
    dayCount: num(row.day_count),
  };
}

type TopOriginsByTeamFilters = LeadGenReportFilters & {
  limitPerTeam: number;
  sortBy: "uniqueProspects" | "submissions" | null;
};

/**
 * `listTopOriginsByTeam`. With no worker the reader sums the
 * `leadGenTeamOriginStats` rows (one per team, source, origin and day,
 * skipping any with no active capture); with a worker it reads the worker's
 * active captures. Either way a team's totals cover all its origins, so the
 * SQL returns them on each row, with every origin ranked within the limit
 * (ties included; the builder breaks them by value).
 */
function topOriginsByTeamSql(input: ReportInput<TopOriginsByTeamFilters>) {
  const { teamId, workerId, source, limitPerTeam, sortBy } = input.filters;
  const filter = captureFilterSql({ teamId, workerId, source });
  const origins = workerId
    ? `
origins AS (
  SELECT
    team_id,
    source,
    origin_key,
    argMin(origin_kind, (submitted_at_ms, creation_time_ms)) AS first_kind,
    argMin(origin_value, (submitted_at_ms, creation_time_ms)) AS first_value,
    count() AS submission_count,
    uniqExact((prospect_id, day_key)) AS unique_prospects,
    uniqExact(day_key) AS day_count
  FROM origin_captures
  WHERE active ${filter.where}
  GROUP BY team_id, source, origin_key
)`
    : `
origin_days AS (
  SELECT
    team_id,
    source,
    origin_key,
    day_key,
    argMin(origin_kind, (submitted_at_ms, creation_time_ms)) AS day_kind,
    argMin(origin_value, (submitted_at_ms, creation_time_ms)) AS day_value,
    min((submitted_at_ms, creation_time_ms)) AS first_at,
    countIf(active) AS day_submissions,
    uniqExactIf(prospect_id, active) AS day_unique_prospects
  FROM origin_captures
  WHERE 1 ${filter.where}
  GROUP BY team_id, source, origin_key, day_key
  HAVING day_submissions > 0
),
origins AS (
  SELECT
    team_id,
    source,
    origin_key,
    argMin(day_kind, (day_key, first_at)) AS first_kind,
    argMin(day_value, (day_key, first_at)) AS first_value,
    sum(day_submissions) AS submission_count,
    sum(day_unique_prospects) AS unique_prospects,
    count() AS day_count
  FROM origin_days
  GROUP BY team_id, source, origin_key
)`;
  return {
    origins: {
      sql: `
WITH${VOIDED_CAPTURES},${RANGE_CAPTURES},${ORIGIN_CAPTURES},${origins}
SELECT *
FROM (
  SELECT
    *,
    sum(unique_prospects) OVER (PARTITION BY team_id) AS team_unique_prospects,
    sum(submission_count) OVER (PARTITION BY team_id) AS team_submissions,
    rank() OVER (
      PARTITION BY team_id
      ORDER BY
        if({by_submissions:Bool}, submission_count, unique_prospects) DESC,
        unique_prospects DESC,
        submission_count DESC
    ) AS origin_rank
  FROM origins
)
WHERE origin_rank <= {limit_per_team:UInt32}`,
      params: {
        ...rangeParams(input.range),
        ...filter.params,
        by_submissions: sortBy === "submissions",
        limit_per_team: limitPerTeam,
      },
    },
  };
}

function teamGroups(rows: SqlRow[] | undefined): TopOriginTeamGroup[] {
  const groups = new Map<string, TopOriginTeamGroup>();
  for (const row of rows ?? []) {
    const teamId = str(row.team_id) as Id<"attributionTeams"> | null;
    const key = teamId ?? "unassigned";
    const group = groups.get(key) ?? {
      teamId,
      totalUniqueProspects: num(row.team_unique_prospects),
      totalSubmissions: num(row.team_submissions),
      origins: [],
    };
    group.origins.push(originFields(row));
    groups.set(key, group);
  }
  return [...groups.values()];
}

export const leadGenOriginReports = [
  defineReport<typeof listTopOrigins, TopOriginsFilters>({
    id: "lead_gen.top_origins",
    page: "lead_gen",
    roles,
    day: "business",
    parseFilters: async (ctx, raw, viewer) => ({
      ...(await parseLeadGenFilters(ctx, raw, viewer)),
      limit: limitFilter(raw.limit, MAX_TOP_ORIGINS),
    }),
    sql: topOriginsSql,
    finalize: async (_ctx, input) =>
      buildTopOrigins((input.rows.origins ?? []).map(originFields), input.filters.limit),
    live: {
      name: "leadGen/reporting:listTopOrigins",
      args: (input) => ({ ...leadGenLiveArgs(input), limit: input.filters.limit }),
    },
  }),
  defineReport<typeof listTopOriginsByTeam, TopOriginsByTeamFilters>({
    id: "lead_gen.top_origins_by_team",
    page: "lead_gen",
    roles,
    day: "business",
    parseFilters: async (ctx, raw, viewer) => ({
      ...(await parseLeadGenFilters(ctx, raw, viewer)),
      limitPerTeam: limitFilter(raw.limitPerTeam, MAX_TOP_ORIGINS_PER_TEAM),
      sortBy: optionalEnumFilter(raw.sortBy, ["uniqueProspects", "submissions"] as const),
    }),
    sql: topOriginsByTeamSql,
    finalize: async (ctx, input) =>
      await buildTopOriginsByTeam(ctx, {
        tenantId: input.tenantId,
        groups: teamGroups(input.rows.origins),
        limitPerTeam: input.filters.limitPerTeam,
        sortBy: input.filters.sortBy ?? undefined,
      }),
    live: {
      name: "leadGen/reporting:listTopOriginsByTeam",
      args: (input) => ({
        ...leadGenLiveArgs(input),
        limitPerTeam: input.filters.limitPerTeam,
        ...(input.filters.sortBy ? { sortBy: input.filters.sortBy } : {}),
      }),
    },
  }),
];
