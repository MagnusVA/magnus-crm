import type { Doc, Id } from "../../_generated/dataModel";
import { buildCallsSummary, type getCallsSummary } from "../../reports/calls";
import { REPORT_ADMIN_ROLES } from "../../reports/lib/access";
import { loadCallFacts, type CallEvidence } from "../../reports/lib/callFacts";
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
// row per meeting so a reschedule chain never multiplies attendance.
export const callFactsSql = `
SELECT m.*,
  coalesce(nullIf(c.closer_id, ''), m.assigned_closer_id) AS report_closer_id,
  if(m.status = 'canceled' AND s.successor_count > 0, 1, 0) AS report_moved,
  if(p.status = 'no_show', 1, 0) AS report_rebooked
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
  SELECT rescheduled_from_meeting_id, count() AS successor_count
  FROM analytics.meetings
  WHERE tenant_id = {tenant_id:String} AND rescheduled_from_meeting_id IS NOT NULL
  GROUP BY rescheduled_from_meeting_id
) AS s ON s.rescheduled_from_meeting_id = m.id
LEFT ANY JOIN (
  SELECT id, status FROM analytics.meetings WHERE tenant_id = {tenant_id:String}
) AS p ON p.id = m.rescheduled_from_meeting_id
ORDER BY m.scheduled_at_ms, m.creation_time_ms, m.id`;

export function callEvidenceFromRows(
  rows: SqlRow[],
): Map<Id<"meetings">, CallEvidence> {
  return new Map(
    rows.map((row) => [
      String(row.id) as Id<"meetings">,
      {
        closerId: (str(row.report_closer_id) ??
          String(row.assigned_closer_id)) as Id<"users">,
        moved: Number(row.report_moved) === 1,
        rebooked: Number(row.report_rebooked) === 1,
      },
    ]),
  );
}
export async function warehouseCallFacts(
  ctx: Parameters<typeof loadCallFacts>[0],
  tenantId: Id<"tenants">,
  rows: SqlRow[],
) {
  const meetings: Doc<"meetings">[] = docsFromRows<"meetings">(rows);
  return await loadCallFacts(
    ctx,
    tenantId,
    meetings,
    Date.now(),
    callEvidenceFromRows(rows),
  );
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
