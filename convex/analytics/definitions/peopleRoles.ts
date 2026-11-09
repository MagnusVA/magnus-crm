import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import { MEMBER_REPORT_ROLES, resolveMemberFilter } from "../../reports/lib/access";
import { loadCreditDimensions, type PeopleRole } from "../../reports/lib/creditFacts";
import { buildPeopleRole, loadRoleHours, type getSetters, type getDmClosers, type getLeadGen } from "../../reports/peopleRoles";
import { defineReport, rangeParams, type ReportInput, type ReportDefinition } from "../definition";
import type { SqlRow } from "../clickhouse";
import { creditFactsFromRows, RANGE_PAYMENTS } from "./attribution";
import { VOIDED_CAPTURES } from "./leadGenShared";

export type PeopleRoleFilters = { memberId: Id<"teamMembers"> | null };

/** Select history only for deals touched by this window; keep every credit for payment-time rules. */
export function peopleRoleSql(range: ResolvedAnalyticsRange, role: PeopleRole, memberId: Id<"teamMembers"> | null) {
  const rangeActivity = role === "setter" ? `
range_qualifications AS (
  SELECT * FROM analytics.qualifications WHERE tenant_id = {tenant_id:String}
    AND submitted_at_ms >= {from_ms:Int64} AND submitted_at_ms < {to_ms:Int64}
),` : role === "dm_closer" ? `
range_meetings AS (
  SELECT * FROM analytics.meetings WHERE tenant_id = {tenant_id:String}
    AND created_at_ms >= {from_ms:Int64} AND created_at_ms < {to_ms:Int64}
),` : "";
  const ctes = `WITH ${RANGE_PAYMENTS}, ${rangeActivity}
range_credits AS (
  SELECT * FROM analytics.attributions WHERE tenant_id = {tenant_id:String}
    AND role = {role:String}
    AND attributed_at_ms >= {from_ms:Int64} AND attributed_at_ms < {to_ms:Int64}
),
relevant_deals AS (
  SELECT opportunity_id FROM range_payments
  UNION DISTINCT SELECT opportunity_id FROM range_credits
  ${role === "setter" ? "UNION DISTINCT SELECT opportunity_id FROM range_qualifications" : ""}
  ${role === "dm_closer" ? "UNION DISTINCT SELECT opportunity_id FROM range_meetings" : ""}
)`;
  const params = { ...rangeParams(range), role };
  const query = (sql: string) => ({ sql: `${ctes}\n${sql}`, params });
  const queries = {
    payments: query("SELECT * FROM range_payments"),
    attributions: query(`SELECT * FROM analytics.attributions WHERE tenant_id = {tenant_id:String}
  AND opportunity_id IN (SELECT opportunity_id FROM relevant_deals)`),
    deals: query(`SELECT * FROM analytics.deals WHERE tenant_id = {tenant_id:String}
  AND id IN (SELECT opportunity_id FROM relevant_deals)`),
    meetings: query(`SELECT * FROM analytics.meetings WHERE tenant_id = {tenant_id:String}
  AND opportunity_id IN (SELECT opportunity_id FROM relevant_deals)`),
    firstPayments: query(`SELECT * FROM analytics.payments WHERE tenant_id = {tenant_id:String}
  AND opportunity_id IN (SELECT opportunity_id FROM relevant_deals)
  AND ifNull(status, '') != 'disputed'
ORDER BY recorded_at_ms, id LIMIT 1 BY opportunity_id`),
    people: query(`SELECT * FROM analytics.people WHERE tenant_id = {tenant_id:String}
  AND id IN (SELECT lead_id FROM analytics.deals WHERE tenant_id = {tenant_id:String}
    AND id IN (SELECT opportunity_id FROM relevant_deals)
    ${role === "setter" ? "UNION DISTINCT SELECT lead_id FROM range_qualifications" : ""})`),
  };
  if (role === "setter") return { ...queries, qualifications: query("SELECT * FROM range_qualifications") };
  if (role === "dm_closer") return queries;
  const captureCtes = `WITH ${VOIDED_CAPTURES}, range_captures AS (
  SELECT * FROM analytics.captures WHERE tenant_id = {tenant_id:String}
    AND submitted_at_ms >= {from_ms:Int64} AND submitted_at_ms < {to_ms:Int64}
    AND id NOT IN (SELECT id FROM voided)
), detail_captures AS (
  SELECT * FROM range_captures
  ${memberId ? "ORDER BY submitted_at_ms DESC, id LIMIT 300 BY worker_id" : "WHERE 0"}
)`;
  return { ...queries,
    captures: { sql: `${captureCtes} SELECT * FROM detail_captures`, params },
    captureStats: { sql: `${captureCtes}
SELECT c.worker_id AS worker_id, p.lead_id AS lead_id,
  toString(toDate(toTimeZone(fromUnixTimestamp64Milli(c.submitted_at_ms), {tz:String}) - toIntervalHour({day_start_hour:UInt8}))) AS day_key,
  count() AS captures
FROM range_captures c
LEFT ANY JOIN (
  SELECT id, lead_id FROM analytics.prospects WHERE tenant_id = {tenant_id:String}
    AND id IN (SELECT prospect_id FROM range_captures)
) p ON c.prospect_id = p.id
GROUP BY c.worker_id, p.lead_id, day_key`, params },
    prospects: { sql: `${captureCtes} SELECT * FROM analytics.prospects WHERE tenant_id = {tenant_id:String}
  AND id IN (SELECT prospect_id FROM detail_captures)`, params },
    people: { sql: `${captureCtes} SELECT * FROM analytics.people WHERE tenant_id = {tenant_id:String}
  AND id IN (SELECT lead_id FROM analytics.prospects WHERE tenant_id = {tenant_id:String}
    AND id IN (SELECT prospect_id FROM detail_captures))`, params },
    resparks: { sql: `SELECT * FROM analytics.respark_items WHERE tenant_id = {tenant_id:String}
  AND worked_at_ms >= {from_ms:Int64} AND worked_at_ms < {to_ms:Int64}`, params },
  };
}

async function finalize(ctx: QueryCtx, input: ReportInput<PeopleRoleFilters> & { rows: Record<string, SqlRow[]> }, role: PeopleRole) {
  const dimensions = await loadCreditDimensions(ctx, input.tenantId);
  return buildPeopleRole(dimensions, creditFactsFromRows(input.rows), input.range, role, input.filters.memberId,
    await loadRoleHours(ctx, input.tenantId, dimensions, role, input.range), Date.now());
}

function options(role: PeopleRole, name: string) {
  return {
    page: "people" as const, roles: MEMBER_REPORT_ROLES, day: "business" as const,
    parseFilters: resolveFilters,
    sql: (input: ReportInput<PeopleRoleFilters>) => peopleRoleSql(input.range, role, input.filters.memberId),
    finalize: (ctx: QueryCtx, input: ReportInput<PeopleRoleFilters> & { rows: Record<string, SqlRow[]> }) => finalize(ctx, input, role),
    live: { name, args: (input: ReportInput<PeopleRoleFilters>) => ({ startDate: input.range.fromMs, endDate: input.range.toMs,
      ...(input.filters.memberId ? { memberId: input.filters.memberId } : {}) }) },
  };
}
const resolveFilters: ReportDefinition<PeopleRoleFilters, unknown>["parseFilters"] = async (ctx, raw, viewer) =>
  ({ memberId: await resolveMemberFilter(ctx, raw.memberId, viewer) });

export const peopleRoleReports = [
  defineReport<typeof getSetters, PeopleRoleFilters>({ id: "people.setters", ...options("setter", "reports/peopleRoles:getSetters") }),
  defineReport<typeof getDmClosers, PeopleRoleFilters>({ id: "people.dm_closers", ...options("dm_closer", "reports/peopleRoles:getDmClosers") }),
  defineReport<typeof getLeadGen, PeopleRoleFilters>({ id: "people.lead_gen", ...options("lead_gen", "reports/peopleRoles:getLeadGen") }),
];
