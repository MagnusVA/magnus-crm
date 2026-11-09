import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import { buildAttributionLanes, buildAttributionPaths, type getLanes, type getPaths } from "../../reports/attribution";
import { REPORT_ADMIN_ROLES } from "../../reports/lib/access";
import { emptyCreditFacts, loadCreditDimensions, type CreditFacts } from "../../reports/lib/creditFacts";
import type { SqlRow } from "../clickhouse";
import { defineReport, noFilters, rangeParams, num, str } from "../definition";
import type { Id } from "../../_generated/dataModel";
import { docsFromRows } from "../rows";

export const RANGE_PAYMENTS = `range_payments AS (
  SELECT * FROM analytics.payments
  WHERE tenant_id = {tenant_id:String}
    AND recorded_at_ms >= {from_ms:Int64} AND recorded_at_ms < {to_ms:Int64}
    AND ifNull(status, '') != 'disputed'
)`;

export function creditFactsFromRows(rows: Record<string, SqlRow[]>): CreditFacts {
  return { ...emptyCreditFacts(), payments: docsFromRows<"paymentRecords">(rows.payments),
    attributions: docsFromRows<"dealAttributions">(rows.attributions), deals: docsFromRows<"opportunities">(rows.deals),
    meetings: docsFromRows<"meetings">(rows.meetings), firstPayments: docsFromRows<"paymentRecords">(rows.firstPayments),
    qualifications: docsFromRows<"slackQualificationEvents">(rows.qualifications), captures: docsFromRows<"leadGenSubmissions">(rows.captures),
    prospects: docsFromRows<"leadGenProspects">(rows.prospects), resparks: docsFromRows<"resparkBatchItems">(rows.resparks),
    people: docsFromRows<"leads">(rows.people),
    ...(rows.captureStats ? { captureStats: rows.captureStats.map(row => ({
      workerId: String(row.worker_id) as Id<"leadGenWorkers">, leadId: str(row.lead_id) as Id<"leads"> | null,
      dayKey: String(row.day_key), captures: num(row.captures),
    })) } : {}) };
}

function attributionSql(range: ResolvedAnalyticsRange) {
  const params = rangeParams(range);
  return {
    payments: { sql: `WITH ${RANGE_PAYMENTS} SELECT * FROM range_payments`, params },
    attributions: { sql: `WITH ${RANGE_PAYMENTS}
SELECT * FROM analytics.attributions
WHERE tenant_id = {tenant_id:String}
  AND opportunity_id IN (SELECT opportunity_id FROM range_payments)`, params },
  };
}

export const attributionReports = [
  defineReport<typeof getLanes>({
    id: "attribution.lanes", page: "attribution", roles: REPORT_ADMIN_ROLES, day: "business", parseFilters: noFilters,
    sql: input => attributionSql(input.range),
    finalize: async (ctx, input) => buildAttributionLanes(await loadCreditDimensions(ctx, input.tenantId), creditFactsFromRows(input.rows), input.range),
    live: { name: "reports/attribution:getLanes", args: input => ({ startDate: input.range.fromMs, endDate: input.range.toMs }) },
  }),
  defineReport<typeof getPaths>({
    id: "attribution.paths", page: "attribution", roles: REPORT_ADMIN_ROLES, day: "business", parseFilters: noFilters,
    sql: input => attributionSql(input.range),
    finalize: async (ctx, input) => buildAttributionPaths(await loadCreditDimensions(ctx, input.tenantId), creditFactsFromRows(input.rows), input.range),
    live: { name: "reports/attribution:getPaths", args: input => ({ startDate: input.range.fromMs, endDate: input.range.toMs }) },
  }),
];
