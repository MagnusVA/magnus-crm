import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import type { LeadGenDailyStatInput } from "../../leadGen/reporting";
import { getSharedDmTeam } from "../../leadGen/sharedTeams";
import type { TenantUserResult } from "../../requireTenantUser";
import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import type { SqlRow } from "../clickhouse";
import {
  num,
  optionalEnumFilter,
  optionalIdFilter,
  rangeParams,
  str,
  type AnalyticsFilters,
  type ReportInput,
} from "../definition";

// Lead gen reports (Operations › Lead Gen, My Activity) run on the tenant
// business day. Their Convex readers read the `leadGenDailyStats`,
// `leadGenOriginStats` and `leadGenTeamOriginStats` buckets, which the capture
// and void hooks keep. ClickHouse rebuilds the same counts from captures, by
// the rule the business-day rebuild applies (convex/leadGen/businessDayRebuild.ts):
//
// - A capture counts while it isn't voided.
// - A prospect's unique credit for a business day goes to its first active
//   capture that day, by `submittedAt` then `_creationTime`. A void of that
//   capture moves the credit to the next one.
// - A capture is a duplicate when the prospect had any earlier capture,
//   voided or not.
// - An origin bucket's unique prospects are the distinct prospects of its
//   active captures.
//
// The synced captures table has no `voidedAt` column until the first void is
// synced, so voids also come from the `lead.capture_voided` events, which
// carry the capture's id (VOIDED_CAPTURES).

export type LeadGenSource = Doc<"leadGenSubmissions">["source"];
export const LEAD_GEN_SOURCES = ["instagram", "meta_business"] as const;

export type LeadGenReportFilters = {
  teamId: Id<"attributionTeams"> | null;
  workerId: Id<"leadGenWorkers"> | null;
  source: LeadGenSource | null;
};

/** The Lead Gen page's filters, checked as `validateFilterIds` checks them. */
export async function parseLeadGenFilters(
  ctx: QueryCtx,
  raw: AnalyticsFilters,
  viewer: TenantUserResult,
): Promise<LeadGenReportFilters> {
  const filters = {
    teamId: optionalIdFilter(ctx, "attributionTeams", raw.teamId),
    workerId: optionalIdFilter(ctx, "leadGenWorkers", raw.workerId),
    source: optionalEnumFilter(raw.source, LEAD_GEN_SOURCES),
  };
  if (filters.teamId && !(await getSharedDmTeam(ctx, { tenantId: viewer.tenantId, teamId: filters.teamId }))) {
    throw new Error("DM team not found");
  }
  if (filters.workerId) {
    const worker = await ctx.db.get("leadGenWorkers", filters.workerId);
    if (!worker || worker.tenantId !== viewer.tenantId) {
      throw new Error("Lead-gen worker not found");
    }
  }
  return filters;
}

/** The reader args for a range and the Lead Gen filters. */
export function leadGenLiveArgs(input: ReportInput<LeadGenReportFilters>) {
  return {
    startDayKey: input.range.startDate,
    endDayKey: input.range.endDateInclusive,
    ...(input.filters.teamId ? { teamId: input.filters.teamId } : {}),
    ...(input.filters.workerId ? { workerId: input.filters.workerId } : {}),
    ...(input.filters.source ? { source: input.filters.source } : {}),
  };
}

/** A capture's tenant business day, `YYYY-MM-DD`, as `timestampToBusinessDateKey` gives it. */
export const CAPTURE_DAY_KEY = `toString(toDate(toTimeZone(fromUnixTimestamp64Milli(assumeNotNull(submitted_at_ms)), {tz:String}) - toIntervalHour({day_start_hour:UInt8})))`;

/**
 * Voided captures: those a `lead.capture_voided` event names, and those with
 * `voided_at_ms` set. The column is NULL until Fivetran syncs the first void,
 * and a void of a capture whose prospect has no person emits no event, so
 * each source covers the other's gap.
 */
export const VOIDED_CAPTURES = `
voided AS (
  SELECT JSONExtractString(metadata, 'submissionId') AS id
  FROM analytics.events
  WHERE tenant_id = {tenant_id:String}
    AND event_type = 'lead.capture_voided'
  UNION ALL
  SELECT id
  FROM analytics.captures
  WHERE tenant_id = {tenant_id:String}
    AND voided_at_ms IS NOT NULL
)`;

/** The range's captures, each with its business day and whether it still counts. */
export const RANGE_CAPTURES = `
range_captures AS (
  SELECT
    id, prospect_id, worker_id, team_id, source, origin_rankable, origin_kind, origin_value,
    submitted_at_ms, creation_time_ms,
    ${CAPTURE_DAY_KEY} AS day_key,
    id NOT IN (SELECT id FROM voided) AS active
  FROM analytics.captures
  WHERE tenant_id = {tenant_id:String}
    AND submitted_at_ms >= {from_ms:Int64}
    AND submitted_at_ms < {to_ms:Int64}
)`;

type CaptureFilters = Partial<Pick<LeadGenReportFilters, "teamId" | "workerId" | "source">>;

/** `AND …` clauses and their parameters for the filters that are set. */
export function captureFilterSql(filters: CaptureFilters) {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (filters.workerId) {
    clauses.push("AND worker_id = {worker_id:String}");
    params.worker_id = filters.workerId;
  }
  if (filters.teamId) {
    clauses.push("AND team_id = {team_id:String}");
    params.team_id = filters.teamId;
  }
  if (filters.source) {
    clauses.push("AND source = {source:String}");
    params.source = filters.source;
  }
  return { where: clauses.join("\n  "), params };
}

/**
 * `leadGenDailyStats` rows rebuilt from captures: one per business day,
 * worker, team and source with a capture in the range, in the order the
 * reader's index returns them (day, then the row's first capture). A row whose
 * captures were all voided stays, with zeros, as the bucket row does.
 */
export function dailyStatsSql(range: ResolvedAnalyticsRange, filters: CaptureFilters) {
  const filter = captureFilterSql(filters);
  return {
    sql: `
WITH${VOIDED_CAPTURES},${RANGE_CAPTURES},
credited AS (
  SELECT argMin(id, (submitted_at_ms, creation_time_ms)) AS id
  FROM range_captures
  WHERE active
  GROUP BY prospect_id, day_key
),
first_attempts AS (
  SELECT argMin(id, (submitted_at_ms, creation_time_ms)) AS id
  FROM analytics.captures
  WHERE tenant_id = {tenant_id:String}
    AND prospect_id IN (SELECT prospect_id FROM range_captures)
  GROUP BY prospect_id
)
SELECT
  day_key,
  worker_id,
  team_id,
  source,
  countIf(active) AS submissions,
  countIf(active AND id IN (SELECT id FROM credited)) AS unique_prospects,
  countIf(active AND id NOT IN (SELECT id FROM first_attempts)) AS duplicates
FROM range_captures
WHERE 1 ${filter.where}
GROUP BY day_key, worker_id, team_id, source
ORDER BY day_key, min((submitted_at_ms, creation_time_ms))`,
    params: { ...rangeParams(range), ...filter.params },
  };
}

/**
 * Daily rows in the shape the builders read. `scheduledHours` is the bucket's
 * snapshot, which the builders use only when the worker has no schedule for
 * the weekday now; schedules are never deleted, so the snapshot is 0 then too.
 */
export function dailyStatRows(rows: SqlRow[] | undefined): LeadGenDailyStatInput[] {
  return (rows ?? []).map((row) => ({
    dayKey: String(row.day_key),
    workerId: String(row.worker_id) as Id<"leadGenWorkers">,
    teamId: (str(row.team_id) ?? undefined) as Id<"attributionTeams"> | undefined,
    source: String(row.source) as LeadGenSource,
    submissions: num(row.submissions),
    uniqueProspectsSubmitted: num(row.unique_prospects),
    duplicateProspectSubmissions: num(row.duplicates),
    scheduledHours: 0,
  }));
}

/** Worked Respark items per worker, as `resparkResultsByWorker` counts them. */
export function resparkResultsSql(range: ResolvedAnalyticsRange, workerId: Id<"leadGenWorkers"> | null) {
  return {
    sql: `
SELECT
  worker_id,
  countIf(result = 'resparked') AS resparks,
  countIf(result = 'not_a_fit') AS not_a_fit
FROM analytics.respark_items
WHERE tenant_id = {tenant_id:String}
  AND worked_at_ms >= {from_ms:Int64}
  AND worked_at_ms < {to_ms:Int64}
  ${workerId ? "AND worker_id = {worker_id:String}" : ""}
GROUP BY worker_id`,
    params: { ...rangeParams(range), ...(workerId ? { worker_id: workerId } : {}) },
  };
}

export function resparkResultCounts(rows: SqlRow[] | undefined) {
  return new Map(
    (rows ?? []).map((row) => [
      String(row.worker_id) as Id<"leadGenWorkers">,
      { resparks: num(row.resparks), notAFit: num(row.not_a_fit) },
    ]),
  );
}
