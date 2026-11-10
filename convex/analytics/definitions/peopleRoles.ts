import type { Id } from "../../_generated/dataModel";
import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import { MEMBER_REPORT_ROLES, resolveMemberFilter } from "../../reports/lib/access";
import { loadCreditDimensions, memberIdentity, type CreditDimensions, type PeopleRole } from "../../reports/lib/creditFacts";
import { buildPeopleRole, loadRoleHours, type PeopleRoleReport, type getSetters, type getDmClosers, type getLeadGen } from "../../reports/peopleRoles";
import { defineReport, nodeFinalize, rangeParams, type NodeBuild, type ReportInput, type ReportDefinition } from "../definition";
import type { SqlQuery } from "../clickhouse";
import { creditFactsFromRows, RANGE_PAYMENTS } from "./attribution";
import { VOIDED_CAPTURES } from "./leadGenShared";

export type PeopleRoleFilters = { memberId: Id<"teamMembers"> | null };
export const PEOPLE_ROLE_CREDIT_ROLES = {
  setter: ["setter"], dm_closer: ["dm_closer", "dm_team"], lead_gen: ["lead_gen"],
} as const;
export const ROLE_ATTRIBUTION_COLUMNS = ["opportunity_id", "role", "team_member_id", "attributed_at_ms", "source_json"] as const;
export const DM_ATTRIBUTION_COLUMNS = [...ROLE_ATTRIBUTION_COLUMNS, "team_id", "meeting_id"] as const;
export const SETTER_DEAL_COLUMNS = ["id", "first_booked_at_ms", "outcome"] as const;
export const SETTER_MEETING_COLUMNS = ["opportunity_id", "status"] as const;
export const QUALIFICATION_COLUMNS = ["id", "submitted_at_ms", "slack_user_id", "slack_team_id", "result_kind", "full_name_snapshot", "lead_id", "opportunity_id"] as const;
export const DM_DEAL_COLUMNS = ["id", "lead_id", "outcome"] as const;
export const DM_MEETING_COLUMNS = ["id", "opportunity_id", "created_at_ms", "rescheduled_from_meeting_id", "status", "scheduled_at_ms", "duration_minutes", "lead_name"] as const;
export const ROLE_PEOPLE_COLUMNS = ["id", "full_name"] as const;
export const ROLE_CAPTURE_COLUMNS = ["id", "worker_id", "prospect_id", "submitted_at_ms", "source"] as const;
export const ROLE_PROSPECT_COLUMNS = ["id", "lead_id"] as const;
export const ROLE_RESPARK_COLUMNS = ["worker_id", "result", "worked_at_ms"] as const;
export const PEOPLE_ROLE_QUERY_NAMES = {
  setter: ["payments", "attributions", "deals", "meetings", "qualifications"],
  dm_closer: ["payments", "attributions", "meetings", "firstPayments"],
  lead_gen: ["payments", "attributions", "firstPayments", "captures", "captureWorkers", "prospects", "people", "resparks"],
} as const;
export const PEOPLE_ROLE_COLUMNS = {
  setter: { payments: null, attributions: ROLE_ATTRIBUTION_COLUMNS, deals: SETTER_DEAL_COLUMNS,
    meetings: SETTER_MEETING_COLUMNS, qualifications: QUALIFICATION_COLUMNS },
  dm_closer: { payments: null, attributions: DM_ATTRIBUTION_COLUMNS, meetings: DM_MEETING_COLUMNS,
    firstPayments: null },
  lead_gen: { payments: null, attributions: ROLE_ATTRIBUTION_COLUMNS, firstPayments: null,
    captures: ROLE_CAPTURE_COLUMNS, captureWorkers: ["worker_id", "days", "lead_ids"],
    prospects: ROLE_PROSPECT_COLUMNS, people: ROLE_PEOPLE_COLUMNS, resparks: ROLE_RESPARK_COLUMNS },
} as const;
export type PeopleRoleContext = {
  dimensions: CreditDimensions;
  hours: { byKey: [string, number][]; isTruncated: boolean };
};

/** Select history only for deals touched by this window; retain every role credit for payment-time rules. */
export function peopleRoleSql(range: ResolvedAnalyticsRange, role: PeopleRole, memberId: Id<"teamMembers"> | null, context?: PeopleRoleContext): Record<string, SqlQuery> {
  const rangeActivity = role === "setter" ? `
range_qualifications AS (
  SELECT ${QUALIFICATION_COLUMNS.join(", ")} FROM analytics.qualifications WHERE tenant_id = {tenant_id:String}
    AND submitted_at_ms >= {from_ms:Int64} AND submitted_at_ms < {to_ms:Int64}
),` : role === "dm_closer" ? `
range_meetings AS (
  SELECT opportunity_id FROM analytics.meetings WHERE tenant_id = {tenant_id:String}
    AND created_at_ms >= {from_ms:Int64} AND created_at_ms < {to_ms:Int64}
),` : "";
  const ctes = `WITH ${RANGE_PAYMENTS}, ${rangeActivity}
range_credits AS (
  SELECT opportunity_id FROM analytics.attributions WHERE tenant_id = {tenant_id:String}
    AND role = {role:String}
    AND attributed_at_ms >= {from_ms:Int64} AND attributed_at_ms < {to_ms:Int64}
),
relevant_deals AS (
  SELECT opportunity_id FROM range_payments
  UNION DISTINCT SELECT opportunity_id FROM range_credits
  ${role === "setter" ? "UNION DISTINCT SELECT opportunity_id FROM range_qualifications" : ""}
  ${role === "dm_closer" ? "UNION DISTINCT SELECT opportunity_id FROM range_meetings" : ""}
)`;
  const params = { ...rangeParams(range), role, credit_roles: [...PEOPLE_ROLE_CREDIT_ROLES[role]] };
  const query = (sql: string): SqlQuery => ({ sql: `${ctes}\n${sql}`, params });
  const creditColumns = PEOPLE_ROLE_COLUMNS[role].attributions.map(column => column === "source_json"
    ? "toJSONString(map('kind', JSONExtractString(ifNull(source_json, '{}'), 'kind'))) AS source_json" : column).join(", ");
  const queries: Record<string, SqlQuery> = {
    payments: query("SELECT * FROM range_payments"),
    attributions: query(`SELECT ${creditColumns} FROM analytics.attributions WHERE tenant_id = {tenant_id:String}
  AND role IN {credit_roles:Array(String)}
  AND opportunity_id IN (SELECT opportunity_id FROM relevant_deals)`),
  };
  if (role === "setter") return { ...queries,
    deals: query(`SELECT ${SETTER_DEAL_COLUMNS.join(", ")} FROM analytics.deals WHERE tenant_id = {tenant_id:String}
  AND id IN (SELECT opportunity_id FROM relevant_deals)`),
    meetings: query(`SELECT ${SETTER_MEETING_COLUMNS.join(", ")} FROM analytics.meetings WHERE tenant_id = {tenant_id:String}
  AND opportunity_id IN (SELECT opportunity_id FROM relevant_deals)`),
    qualifications: query(`SELECT ${QUALIFICATION_COLUMNS.join(", ")} FROM range_qualifications`),
  };
  queries.firstPayments = query(`SELECT * FROM (
  SELECT * FROM analytics.payments WHERE tenant_id = {tenant_id:String}
    AND opportunity_id IN (SELECT opportunity_id FROM relevant_deals)
    AND status IN ('recorded', 'verified')
  ORDER BY recorded_at_ms, creation_time_ms, id LIMIT 1 BY opportunity_id, status
)
ORDER BY recorded_at_ms, id LIMIT 1 BY opportunity_id`);
  if (role === "dm_closer") return { ...queries,
    meetings: query(`SELECT ${DM_MEETING_COLUMNS.join(", ")} FROM analytics.meetings WHERE tenant_id = {tenant_id:String}
  AND opportunity_id IN (SELECT opportunity_id FROM relevant_deals)`),
    ...(memberId ? {
      deals: query(`SELECT ${DM_DEAL_COLUMNS.join(", ")} FROM analytics.deals WHERE tenant_id = {tenant_id:String}
  AND id IN (SELECT opportunity_id FROM relevant_deals)`),
      people: query(`SELECT ${ROLE_PEOPLE_COLUMNS.join(", ")} FROM analytics.people WHERE tenant_id = {tenant_id:String}
  AND id IN (SELECT lead_id FROM analytics.deals WHERE tenant_id = {tenant_id:String}
    AND id IN (SELECT opportunity_id FROM relevant_deals))`),
    } : {}),
  };
  const memberWorkerIds = context && memberId ? context.dimensions.workers.filter(worker =>
    memberIdentity(context.dimensions, worker.teamMemberId).teamMemberId === memberId).map(worker => worker._id) : [];
  const captureParams = { ...params, member_worker_ids: memberWorkerIds };
  const captureCtes = `WITH ${VOIDED_CAPTURES}, range_captures AS (
  SELECT ${ROLE_CAPTURE_COLUMNS.join(", ")} FROM analytics.captures WHERE tenant_id = {tenant_id:String}
    AND submitted_at_ms >= {from_ms:Int64} AND submitted_at_ms < {to_ms:Int64}
    AND id NOT IN (SELECT id FROM voided)
), detail_captures AS (
  SELECT ${ROLE_CAPTURE_COLUMNS.join(", ")} FROM range_captures
  WHERE worker_id IN {member_worker_ids:Array(String)}
  ORDER BY submitted_at_ms DESC, id LIMIT 300
)`;
  return { ...queries,
    captures: { sql: `${captureCtes} SELECT ${ROLE_CAPTURE_COLUMNS.join(", ")} FROM detail_captures`, params: captureParams },
    captureWorkers: { sql: `${captureCtes}
SELECT worker_id, groupArray((day_key, captures)) AS days,
  arrayDistinct(arrayFlatten(groupArray(lead_ids))) AS lead_ids
FROM (
  SELECT c.worker_id AS worker_id,
    toString(toDate(toTimeZone(fromUnixTimestamp64Milli(c.submitted_at_ms), {tz:String}) - toIntervalHour({day_start_hour:UInt8}))) AS day_key,
    count() AS captures,
    groupUniqArrayIf(p.lead_id, ifNull(p.lead_id, '') != '') AS lead_ids
  FROM range_captures c
  LEFT ANY JOIN (
    SELECT id, lead_id FROM analytics.prospects WHERE tenant_id = {tenant_id:String}
      AND id IN (SELECT prospect_id FROM range_captures)
  ) p ON c.prospect_id = p.id
  GROUP BY c.worker_id, day_key
)
GROUP BY worker_id`, params: captureParams },
    prospects: { sql: `${captureCtes} SELECT ${ROLE_PROSPECT_COLUMNS.join(", ")} FROM analytics.prospects WHERE tenant_id = {tenant_id:String}
  AND id IN (SELECT prospect_id FROM detail_captures)`, params: captureParams },
    people: { sql: `${captureCtes} SELECT ${ROLE_PEOPLE_COLUMNS.join(", ")} FROM analytics.people WHERE tenant_id = {tenant_id:String}
  AND id IN (SELECT lead_id FROM analytics.prospects WHERE tenant_id = {tenant_id:String}
    AND id IN (SELECT prospect_id FROM detail_captures))`, params: captureParams },
    resparks: { sql: `SELECT ${ROLE_RESPARK_COLUMNS.join(", ")} FROM analytics.respark_items WHERE tenant_id = {tenant_id:String}
  AND worked_at_ms >= {from_ms:Int64} AND worked_at_ms < {to_ms:Int64}`, params },
  };
}

function options(role: PeopleRole, name: string) {
  const node: NodeBuild<PeopleRoleFilters, PeopleRoleReport, PeopleRoleContext> = {
    context: async (ctx, input) => {
      const dimensions = await loadCreditDimensions(ctx, input.tenantId);
      const hours = await loadRoleHours(ctx, input.tenantId, dimensions, role, input.range);
      return { dimensions, hours: { ...hours, byKey: [...hours.byKey] } };
    },
    build: input => buildPeopleRole(input.context.dimensions, creditFactsFromRows(input.rows), input.range, role,
      input.filters.memberId, { ...input.context.hours, byKey: new Map(input.context.hours.byKey) }, Date.now()),
  };
  return {
    page: "people" as const, roles: MEMBER_REPORT_ROLES, day: "business" as const,
    parseFilters: resolveFilters,
    sql: (input: ReportInput<PeopleRoleFilters>, context?: PeopleRoleContext) => peopleRoleSql(input.range, role, input.filters.memberId, context),
    node, finalize: nodeFinalize(node),
    live: { name, args: (input: ReportInput<PeopleRoleFilters>) => ({ startDate: input.range.fromMs, endDate: input.range.toMs,
      ...(input.filters.memberId ? { memberId: input.filters.memberId } : {}) }) },
  };
}
const resolveFilters: ReportDefinition<PeopleRoleFilters, unknown>["parseFilters"] = async (ctx, raw, viewer) =>
  ({ memberId: await resolveMemberFilter(ctx, raw.memberId, viewer) });

export const peopleRoleReports = [
  defineReport<typeof getSetters, PeopleRoleFilters, PeopleRoleContext>({ id: "people.setters", ...options("setter", "reports/peopleRoles:getSetters") }),
  defineReport<typeof getDmClosers, PeopleRoleFilters, PeopleRoleContext>({ id: "people.dm_closers", ...options("dm_closer", "reports/peopleRoles:getDmClosers") }),
  defineReport<typeof getLeadGen, PeopleRoleFilters, PeopleRoleContext>({ id: "people.lead_gen", ...options("lead_gen", "reports/peopleRoles:getLeadGen") }),
];
