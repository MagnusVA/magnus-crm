import type { Id } from "../../_generated/dataModel";
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

// Pre-filter every input by tenant, then reduce credits and successors to one
// row per meeting so a reschedule chain never multiplies attendance. Joined
// columns never share a meeting column's name: ClickHouse would return the
// meeting's as `m.id`, `m.status`, and the row would lose them.
export const callFactsSql = `
SELECT m.*,
  coalesce(nullIf(c.closer_id, ''), m.assigned_closer_id) AS report_closer_id,
  if(m.status = 'canceled' AND s.successor_count > 0, 1, 0) AS report_moved,
  if(p.previous_status = 'no_show', 1, 0) AS report_rebooked,
  nullIf(d.outcome, '') AS report_deal_outcome,
  nullIf(d.event_type_config_id, '') AS report_event_type_config_id,
  ifNull(e.is_extended, 0) AS report_is_extended,
  coalesce(m.lead_name, nullIf(person.full_name, ''), 'Unknown person') AS report_lead_name
FROM (
  SELECT * FROM analytics.meetings
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
export async function warehouseCallFacts(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rows: SqlRow[],
): Promise<CallFacts> {
  const meetings = docsFromRows<"meetings">(rows).filter(
    (m) => m.tenantId === tenantId,
  );
  const evidence = callEvidenceFromRows(rows);
  const closerIds = [
    ...new Set(meetings.map((m) => evidence.get(m._id)!.closerId)),
  ];
  // Warehouse SQL already supplies the per-meeting dimensions. Only the small
  // current closer directory is read here, without the live report budgets.
  const users = await Promise.all(
    closerIds.map((id) => ctx.db.get("users", id)),
  );
  const byId = new Map(
    users.flatMap((u) =>
      u?.tenantId === tenantId ? [[u._id, u] as const] : [],
    ),
  );
  const now = Date.now();
  return {
    partial: false,
    facts: meetings.map((meeting) => {
      const proof = evidence.get(meeting._id)!;
      const closer = byId.get(proof.closerId);
      return {
        ...proof,
        meeting,
        ...callState(meeting, proof, now),
        closerName: closer ? getUserDisplayName(closer) : "Removed closer",
        programName: meeting.bookingProgramName ?? "Unknown program",
      };
    }),
  };
}
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
  defineReport<typeof getCallsSummary, CallsReportFilters>({
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
    finalize: async (ctx, input) =>
      buildCallsSummary(
        await warehouseCallFacts(
          ctx,
          input.tenantId,
          input.rows.meetings ?? [],
        ),
        input.filters,
        input.range,
      ),
    live: { name: "reports/calls:getCallsSummary", args: callsLiveArgs },
  }),
];
