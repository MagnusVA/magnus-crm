import type { Id } from "../../_generated/dataModel";
import {
  buildProspectConversions,
  loadConversionWorkers,
  type listProspectConversions,
  type ProspectConversionCounts,
} from "../../leadGen/conversions";
import {
  buildResparkPerformance,
  loadResparkWorkers,
  type listResparkPerformance,
} from "../../leadGen/resparkReports";
import { PERMISSIONS } from "../../lib/permissions";
import type { SqlRow } from "../clickhouse";
import {
  defineReport,
  noFilters,
  num,
  optionalEnumFilter,
  rangeParams,
  type ReportInput,
} from "../definition";
import {
  LEAD_GEN_SOURCES,
  RANGE_CAPTURES,
  resparkResultCounts,
  resparkResultsSql,
  VOIDED_CAPTURES,
  type LeadGenSource,
} from "./leadGenShared";

// Prospect conversion and Respark performance. Their readers count the
// `prospectConversions`, `leadGenDealsByWorker` and `resparkResultsByWorker`
// aggregates; the SQL counts the documents those aggregates index. The
// worker list stays a live read in the builders.

function byWorker<Value>(rows: SqlRow[] | undefined, value: (row: SqlRow) => Value) {
  return new Map(
    (rows ?? []).map((row) => [String(row.worker_id) as Id<"leadGenWorkers">, value(row)]),
  );
}

/**
 * `prospectConversions` holds a prospect at Prospect, and at each later stage
 * its person reached at or after the prospect's first capture, while the
 * person isn't merged (`prospectConversionStages`).
 */
function conversionsSql(input: ReportInput<Record<string, never>>) {
  const reached = (stage: string) =>
    `countIf(JSONExtract(people.lifecycle_stage_entered_at_json, '${stage}', 'Nullable(Float64)') >= prospects.first_captured_at_ms) AS ${stage}`;
  return {
    stages: {
      sql: `
SELECT
  prospects.first_captured_by_worker_id AS worker_id,
  count() AS prospect,
  ${["in_conversation", "qualified", "booked", "showed", "customer"].map(reached).join(",\n  ")}
FROM analytics.prospects AS prospects
INNER JOIN (
  SELECT id, lifecycle_stage_entered_at_json
  FROM analytics.people
  WHERE tenant_id = {tenant_id:String}
    AND ifNull(status, '') != 'merged'
) AS people ON people.id = prospects.lead_id
WHERE prospects.tenant_id = {tenant_id:String}
  AND prospects.first_captured_at_ms >= {from_ms:Int64}
  AND prospects.first_captured_at_ms < {to_ms:Int64}
GROUP BY worker_id`,
      params: rangeParams(input.range),
    },
    // `leadGenDealsByWorker`: lead gen attribution rows credited to a capture.
    deals: {
      sql: `
SELECT JSONExtractString(source_json, 'workerId') AS worker_id, count() AS deals
FROM analytics.attributions
WHERE tenant_id = {tenant_id:String}
  AND role = 'lead_gen'
  AND JSONExtractString(source_json, 'kind') = 'capture'
  AND attributed_at_ms >= {from_ms:Int64}
  AND attributed_at_ms < {to_ms:Int64}
GROUP BY worker_id`,
      params: rangeParams(input.range),
    },
  };
}

type ResparkFilters = { source: LeadGenSource | null };

function resparkSql(input: ReportInput<ResparkFilters>) {
  const { source } = input.filters;
  return {
    raw: {
      sql: `
WITH${VOIDED_CAPTURES},${RANGE_CAPTURES}
SELECT worker_id, countIf(active) AS raw_leads
FROM range_captures
WHERE 1 ${source ? "AND source = {source:String}" : ""}
GROUP BY worker_id`,
      params: { ...rangeParams(input.range), ...(source ? { source } : {}) },
    },
    resparks: resparkResultsSql(input.range, null),
    // Respark credits whose deal was ever booked.
    booked: {
      sql: `
SELECT JSONExtractString(source_json, 'workerId') AS worker_id, count() AS booked
FROM analytics.attributions
WHERE tenant_id = {tenant_id:String}
  AND JSONExtractString(source_json, 'kind') = 'respark'
  AND attributed_at_ms >= {from_ms:Int64}
  AND attributed_at_ms < {to_ms:Int64}
  AND opportunity_id IN (
    SELECT id
    FROM analytics.deals
    WHERE tenant_id = {tenant_id:String}
      AND first_booked_at_ms IS NOT NULL
  )
GROUP BY worker_id`,
      params: rangeParams(input.range),
    },
  };
}

const dayArgs = (input: ReportInput<unknown>) => ({
  startDayKey: input.range.startDate,
  endDayKey: input.range.endDateInclusive,
});

export const leadGenPeopleReports = [
  defineReport<typeof listProspectConversions>({
    id: "lead_gen.prospect_conversions",
    page: "lead_gen",
    roles: ["tenant_master", "tenant_admin"],
    day: "business",
    parseFilters: noFilters,
    sql: conversionsSql,
    finalize: async (ctx, input) =>
      await buildProspectConversions(ctx, await loadConversionWorkers(ctx, input.tenantId), {
        counts: byWorker(input.rows.stages, (row): ProspectConversionCounts => ({
          prospect: num(row.prospect),
          in_conversation: num(row.in_conversation),
          qualified: num(row.qualified),
          booked: num(row.booked),
          showed: num(row.showed),
          customer: num(row.customer),
        })),
        deals: { byWorker: byWorker(input.rows.deals, (row) => num(row.deals)), capped: false },
      }),
    live: { name: "leadGen/conversions:listProspectConversions", args: dayArgs },
  }),
  defineReport<typeof listResparkPerformance, ResparkFilters>({
    id: "lead_gen.respark_performance",
    page: "lead_gen",
    roles: PERMISSIONS["lead-gen:view-all"],
    day: "business",
    parseFilters: async (_ctx, raw) => ({ source: optionalEnumFilter(raw.source, LEAD_GEN_SOURCES) }),
    sql: resparkSql,
    finalize: async (ctx, input) =>
      await buildResparkPerformance(ctx, await loadResparkWorkers(ctx, input.tenantId), {
        rawByWorker: byWorker(input.rows.raw, (row) => num(row.raw_leads)),
        counts: resparkResultCounts(input.rows.resparks),
        bookedByWorker: byWorker(input.rows.booked, (row) => num(row.booked)),
        bookedCapped: false,
      }),
    live: {
      name: "leadGen/resparkReports:listResparkPerformance",
      args: (input) => ({
        ...dayArgs(input),
        ...(input.filters.source ? { source: input.filters.source } : {}),
      }),
    },
  }),
];
