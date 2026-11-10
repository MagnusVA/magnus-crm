import type { Doc, Id } from "../../_generated/dataModel";
import { buildCallsSummary, type getCallsSummary } from "../../reports/calls";
import { REPORT_ADMIN_ROLES } from "../../reports/lib/access";
import type { QueryCtx } from "../../_generated/server";
import {
  callState,
  type CallEvidence,
  type CallFacts,
} from "../../reports/lib/callFacts";
import { getUserDisplayName } from "../../reporting/lib/helpers";
import type { SqlRow } from "../clickhouse";
import {
  defineReport,
  nodeFinalize,
  type NodeBuild,
  type ReaderOutput,
  optionalEnumFilter,
  optionalIdFilter,
  rangeParams,
  str,
  type ReportInput,
} from "../definition";
import { docsFromRows } from "../rows";

export type CallsReportFilters = {
  programId: Id<"tenantPrograms"> | null;
  closerId: Id<"users"> | null;
  callType: "new" | "follow_up" | null;
};

export const CALL_MEETING_COLUMNS = [
  "id", "tenant_id", "creation_time_ms", "opportunity_id", "assigned_closer_id",
  "scheduled_at_ms", "duration_minutes", "status", "created_at_ms",
  "rescheduled_from_meeting_id", "held_marked_at_ms", "no_show_marked_at_ms",
  "no_show_source", "no_show_reason", "call_classification", "booking_program_id",
  "booking_program_name", "lead_name",
] as const;
export const CALL_EVIDENCE_COLUMNS = [
  "report_closer_id", "report_moved", "report_rebooked", "report_deal_outcome",
  "report_event_type_config_id", "report_is_extended", "report_lead_name",
] as const;
export const CALL_COLUMNS = [...CALL_MEETING_COLUMNS, ...CALL_EVIDENCE_COLUMNS] as const;
export const CALL_QUERY_NAMES = ["meetings"] as const;

// Pre-filter every input by tenant, then reduce credits and successors to one
// row per meeting so a reschedule chain never multiplies attendance. Joined
// columns never share a meeting column's name: ClickHouse would return the
// meeting's as `m.id`, `m.status`, and the row would lose them.
export const callFactsSql = `
SELECT ${CALL_MEETING_COLUMNS.map(column => `m.${column}`).join(", ")},
  coalesce(nullIf(c.closer_id, ''), m.assigned_closer_id) AS report_closer_id,
  if(m.status = 'canceled' AND s.successor_count > 0, 1, 0) AS report_moved,
  if(p.previous_status = 'no_show', 1, 0) AS report_rebooked,
  nullIf(d.outcome, '') AS report_deal_outcome,
  nullIf(d.event_type_config_id, '') AS report_event_type_config_id,
  ifNull(e.is_extended, 0) AS report_is_extended,
  coalesce(m.lead_name, nullIf(person.full_name, ''), 'Unknown person') AS report_lead_name
FROM (
  SELECT ${CALL_MEETING_COLUMNS.join(", ")} FROM analytics.meetings
  WHERE tenant_id = {tenant_id:String}
    AND scheduled_at_ms >= {from_ms:Int64} AND scheduled_at_ms < {to_ms:Int64}
) AS m
LEFT ANY JOIN (
  SELECT meeting_id,
    JSONExtractString(argMax(source_json, (attributed_at_ms, creation_time_ms, id)), 'userId') AS closer_id
  FROM analytics.attributions
  WHERE tenant_id = {tenant_id:String} AND role = 'closer'
  GROUP BY meeting_id
) AS c ON c.meeting_id = m.id
LEFT ANY JOIN (
  SELECT rescheduled_from_meeting_id AS replaced_id, count() AS successor_count
  FROM analytics.meetings
  WHERE tenant_id = {tenant_id:String} AND rescheduled_from_meeting_id IS NOT NULL
  GROUP BY replaced_id
) AS s ON s.replaced_id = m.id
LEFT ANY JOIN (
  SELECT id AS previous_id, status AS previous_status FROM analytics.meetings WHERE tenant_id = {tenant_id:String}
) AS p ON p.previous_id = m.rescheduled_from_meeting_id
LEFT ANY JOIN (
  SELECT id AS deal_id, outcome, event_type_config_id, lead_id
  FROM analytics.deals WHERE tenant_id = {tenant_id:String}
) AS d ON d.deal_id = m.opportunity_id
LEFT ANY JOIN (
  SELECT id AS event_type_id, is_extended FROM analytics.event_types WHERE tenant_id = {tenant_id:String}
) AS e ON e.event_type_id = d.event_type_config_id
LEFT ANY JOIN (
  SELECT id AS person_id, full_name FROM analytics.people WHERE tenant_id = {tenant_id:String}
) AS person ON person.person_id = d.lead_id
ORDER BY m.scheduled_at_ms, m.creation_time_ms, m.id`;

// Share the exact evidence joins without changing calls.summary's SQL text.
export const callEvidenceJoinsSql = callFactsSql.slice(
  callFactsSql.indexOf("\nLEFT ANY JOIN"), callFactsSql.lastIndexOf("\nORDER BY"),
);

export type WarehouseCallEvidence = CallEvidence & {
  dealOutcome: "open" | "won" | "lost" | null;
  eventTypeConfigId: Id<"eventTypeConfigs"> | null;
  standard: boolean;
  leadName: string;
};

export function callEvidenceFromRows(
  rows: SqlRow[],
): Map<Id<"meetings">, WarehouseCallEvidence> {
  return new Map(
    rows.map((row) => [
      String(row.id) as Id<"meetings">,
      {
        closerId: (str(row.report_closer_id) ??
          String(row.assigned_closer_id)) as Id<"users">,
        moved: Number(row.report_moved) === 1,
        rebooked: Number(row.report_rebooked) === 1,
        dealOutcome:
          row.report_deal_outcome === "open" ||
          row.report_deal_outcome === "won" ||
          row.report_deal_outcome === "lost"
            ? row.report_deal_outcome
            : null,
        eventTypeConfigId: str(
          row.report_event_type_config_id,
        ) as Id<"eventTypeConfigs"> | null,
        standard: Number(row.report_is_extended) === 1,
        leadName:
          str(row.report_lead_name) ?? str(row.lead_name) ?? "Unknown person",
      },
    ]),
  );
}
export function callCloserKeys(rows: Record<string, SqlRow[]>): string[] {
  return [...new Set([...callEvidenceFromRows(rows.meetings ?? []).values()].map(proof => proof.closerId))];
}
export async function loadCallUsers(ctx: QueryCtx, tenantId: Id<"tenants">, keys: readonly string[]) {
  const users = await Promise.all(keys.map(key => {
    const id = ctx.db.normalizeId("users", key);
    return id ? ctx.db.get("users", id) : null;
  }));
  return users.filter((user): user is Doc<"users"> => user?.tenantId === tenantId);
}
export function buildWarehouseCallFacts(tenantId: Id<"tenants">, rows: SqlRow[], users: Doc<"users">[]): CallFacts {
  const meetings = docsFromRows<"meetings">(rows).filter(m => m.tenantId === tenantId);
  const evidence = callEvidenceFromRows(rows);
  const byId = new Map(users.map(user => [user._id, user]));
  const now = Date.now();
  return {
    partial: false,
    facts: meetings.map(meeting => {
      const proof = evidence.get(meeting._id)!;
      const closer = byId.get(proof.closerId);
      return {
        ...proof, meeting, ...callState(meeting, proof, now),
        closerName: closer ? getUserDisplayName(closer) : "Removed closer",
        programName: meeting.bookingProgramName ?? "Unknown program",
      };
    }),
  };
}
export async function warehouseCallFacts(ctx: QueryCtx, tenantId: Id<"tenants">, rows: SqlRow[]): Promise<CallFacts> {
  return buildWarehouseCallFacts(tenantId, rows, await loadCallUsers(ctx, tenantId, callCloserKeys({ meetings: rows })));
}
const callsNode: NodeBuild<CallsReportFilters, ReaderOutput<typeof getCallsSummary>, Doc<"users">[]> = {
  keys: callCloserKeys,
  context: (ctx, input, keys) => loadCallUsers(ctx, input.tenantId, keys),
  build: input => buildCallsSummary(
    buildWarehouseCallFacts(input.tenantId, input.rows.meetings ?? [], input.context),
    input.filters, input.range,
  ),
};
export function callsLiveArgs(input: ReportInput<CallsReportFilters>) {
  return {
    startDate: input.range.fromMs,
    endDate: input.range.toMs,
    ...(input.filters.programId ? { programId: input.filters.programId } : {}),
    ...(input.filters.closerId ? { closerId: input.filters.closerId } : {}),
    ...(input.filters.callType ? { callType: input.filters.callType } : {}),
  };
}
export const callsReports = [
  defineReport<typeof getCallsSummary, CallsReportFilters, Doc<"users">[]>({
    id: "calls.summary",
    page: "calls",
    roles: REPORT_ADMIN_ROLES,
    day: "business",
    parseFilters: async (ctx, raw) => ({
      programId: optionalIdFilter(ctx, "tenantPrograms", raw.programId),
      closerId: optionalIdFilter(ctx, "users", raw.closerId),
      callType: optionalEnumFilter(raw.callType, ["new", "follow_up"] as const),
    }),
    sql: (input) => ({
      meetings: { sql: callFactsSql, params: rangeParams(input.range) },
    }),
    node: callsNode,
    finalize: nodeFinalize(callsNode),
    live: { name: "reports/calls:getCallsSummary", args: callsLiveArgs },
  }),
];
