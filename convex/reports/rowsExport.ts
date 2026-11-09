import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalQuery, type QueryCtx } from "../_generated/server";
import { isClickHouseConfigured, queryTenantClickHouse, queryWatermark, type SqlQuery, type SqlRow } from "../analytics/clickhouse";
import { rangeParams } from "../analytics/definition";
import { requireTenantUser } from "../requireTenantUser";
import { requireTenantUserFromAction } from "../requireTenantUserFromAction";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { isMovedSlot } from "../lib/callType";
import { expectedError } from "../lib/observability/errors";
import { REPORT_ADMIN_ROLES } from "./lib/access";
import { getEventLabel } from "../reporting/lib/eventLabels";
import { liveReader, scorecardRangeValidator, type LiveReader } from "./lib/scorecardFacts";
import { resolveAnalyticsRange, type ResolvedAnalyticsRange } from "../../lib/analyticsRange";
import { businessDateForInstant, businessDayStart } from "../../lib/businessDay";
import { renderCsv } from "../../lib/operations-reports/csv";
import type { ReportColumn, ReportRecord } from "../../lib/operations-reports/document";
import { meetingAttendanceDisplay } from "../../lib/status-config";

export type RowsKind = "payments" | "calls" | "credits" | "events";
export const MAX_EXPORT_ROWS = 200_000;
const kindValidator = v.union(v.literal("payments"), v.literal("calls"), v.literal("credits"), v.literal("events"));
const rowValidator = v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null()));
const datesValidator = v.object({ startDate: v.string(), endDateInclusive: v.string() });
/** The page's filters, so a rows export holds the records the page shows. */
export type RowsFilters = {
  programId?: Id<"tenantPrograms">;
  closerId?: Id<"users">;
  callType?: "new" | "follow_up";
  /** Log: the member, the login whose actions count as theirs, and the record type. */
  teamMemberId?: Id<"teamMembers">;
  actorUserId?: Id<"users">;
  entityType?: string;
};
const filtersValidator = v.object({
  programId: v.optional(v.id("tenantPrograms")),
  closerId: v.optional(v.id("users")),
  callType: v.optional(v.union(v.literal("new"), v.literal("follow_up"))),
  teamMemberId: v.optional(v.id("teamMembers")),
  actorUserId: v.optional(v.id("users")),
  entityType: v.optional(v.string()),
});
const tooLarge = () => expectedError("rows_export_too_large", "Choose a shorter range");
const columns = (pairs: [string, string][]): ReportColumn[] => pairs.map(([key, label]) => ({ key, label }));
export const ROW_COLUMNS: Record<RowsKind, ReportColumn[]> = {
  payments: columns([["paymentId", "Payment id"], ["recordedAt", "Recorded at (ISO)"], ["timeZone", "Tenant time zone"],
    ["dealId", "Deal id"], ["personName", "Person name"], ["program", "Program"], ["type", "Type"], ["status", "Status"],
    ["currency", "Currency"], ["amount", "Amount"], ["closerName", "Closer name"]]),
  calls: columns([["meetingId", "Meeting id"], ["scheduledAt", "Scheduled at (ISO)"], ["createdAt", "Created at (ISO)"],
    ["timeZone", "Tenant time zone"], ["dealId", "Deal id"], ["personName", "Person name"], ["closerName", "Closer at the time"],
    ["callType", "Call type"], ["attendance", "Attendance"], ["replacedMeetingId", "Replaced meeting id"]]),
  credits: columns([["paymentId", "Payment id"], ["recordedAt", "Recorded at (ISO)"], ["timeZone", "Tenant time zone"],
    ["dealId", "Deal id"], ["personName", "Person name"], ["program", "Program"], ["type", "Type"], ["status", "Status"],
    ["currency", "Currency"], ["amount", "Amount"], ["teamMemberId", "Credited person id"], ["creditedName", "Credited person"], ["role", "Role"],
    ["teamId", "Credited team id"]]),
  // Metadata stays out: it can hold free text, and the log shows it on screen.
  events: columns([["eventId", "Event id"], ["occurredAt", "Occurred at (ISO)"], ["timeZone", "Tenant time zone"],
    ["label", "What happened"], ["eventType", "Event type"], ["entityType", "Record type"], ["entityId", "Record id"],
    ["actorName", "Done by"], ["memberName", "Team member"], ["source", "Source"], ["fromStatus", "From"], ["toStatus", "To"], ["reason", "Reason"]]),
};
export function assembleRowsCsv(kind: RowsKind, history: ReportRecord[], live: ReportRecord[]): ArrayBuffer {
  if (history.length + live.length > MAX_EXPORT_ROWS) throw tooLarge();
  const bytes = renderCsv(ROW_COLUMNS[kind], [...history, ...live]);
  // Convex function values have a 16 MiB limit even below the row cap.
  if (bytes.byteLength > 15 * 1024 * 1024) throw tooLarge();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
const paymentSelect = `p.id AS payment_id, p.recorded_at_ms, p.opportunity_id AS deal_id,
  l.full_name AS person_name, p.program_name AS program, p.payment_type AS type,
  p.status, p.currency, p.amount_minor`;
const paymentFrom = (filters: RowsFilters) => `FROM (
  SELECT * FROM analytics.payments WHERE tenant_id = {tenant_id:String}
    AND recorded_at_ms >= {from_ms:Int64} AND recorded_at_ms < {to_ms:Int64}${filters.programId ? "\n    AND program_id = {program_id:String}" : ""}
) AS p
LEFT ANY JOIN (SELECT id, lead_id FROM analytics.deals WHERE tenant_id = {tenant_id:String}) AS d ON d.id = p.opportunity_id
LEFT ANY JOIN (SELECT id, full_name FROM analytics.people WHERE tenant_id = {tenant_id:String}) AS l ON l.id = d.lead_id`;
export function rowsExportSql(kind: RowsKind, range: ResolvedAnalyticsRange, now: number, filters: RowsFilters = {}): SqlQuery {
  let sql: string;
  if (kind === "payments") {
    sql = `SELECT ${paymentSelect}, u.full_name AS closer_name ${paymentFrom(filters)}
LEFT ANY JOIN (SELECT id, full_name FROM analytics.users WHERE tenant_id = {tenant_id:String}) AS u ON u.id = p.attributed_closer_id
ORDER BY p.recorded_at_ms, p.id`;
  } else if (kind === "credits") {
    // The same credit as Attribution: every role but closer from the deal's
    // credit rows (earliest per identity and role, so repeated facts never
    // multiply a payment, and a later credit never claims an earlier payment),
    // and the closer from the payment's own attributed closer. Disputed
    // payments credit no one.
    sql = `SELECT * FROM (
SELECT ${paymentSelect}, c.credited_member_id AS team_member_id, c.role AS role,
  if(c.role = 'dm_team', coalesce(nullIf(t.display_name, ''), 'Unknown team'), tm.display_name) AS credited_name,
  c.credited_team_id AS team_id ${paymentFrom(filters)}
INNER JOIN (
  SELECT opportunity_id, if(role = 'dm_team', '', ifNull(team_member_id, '')) AS credited_member_id,
    if(role = 'dm_team', ifNull(team_id, ''), '') AS credited_team_id, role, min(attributed_at_ms) AS attributed_at_ms
  FROM analytics.attributions WHERE tenant_id = {tenant_id:String} AND role != 'closer'
    AND if(role = 'dm_team', ifNull(team_id, '') != '', ifNull(team_member_id, '') != '')
  GROUP BY opportunity_id, credited_member_id, credited_team_id, role
) AS c ON c.opportunity_id = p.opportunity_id
LEFT ANY JOIN (SELECT id, display_name FROM analytics.team_members WHERE tenant_id = {tenant_id:String}) AS tm ON tm.id = c.credited_member_id
LEFT ANY JOIN (SELECT id, display_name FROM analytics.teams WHERE tenant_id = {tenant_id:String}) AS t ON t.id = c.credited_team_id
WHERE c.attributed_at_ms <= p.recorded_at_ms AND ifNull(p.status, '') != 'disputed'
UNION ALL
SELECT ${paymentSelect}, u.team_member_id AS team_member_id, 'closer' AS role,
  coalesce(nullIf(tm.display_name, ''), u.full_name) AS credited_name, '' AS team_id ${paymentFrom(filters)}
INNER JOIN (SELECT id, team_member_id, full_name FROM analytics.users WHERE tenant_id = {tenant_id:String}) AS u ON u.id = p.attributed_closer_id
LEFT ANY JOIN (SELECT id, display_name FROM analytics.team_members WHERE tenant_id = {tenant_id:String}) AS tm ON tm.id = u.team_member_id
WHERE ifNull(p.status, '') != 'disputed'
)
ORDER BY recorded_at_ms, payment_id, team_member_id, role, team_id`;
  } else if (kind === "events") {
    // A member's events are their login's own actions plus events tagged
    // with them, as the Log's member filter reads them (reports/log.ts).
    const member = filters.teamMemberId
      ? filters.actorUserId
        ? "\n  AND ((actor_user_id = {actor_user_id:String} AND ifNull(team_member_id, {team_member_id:String}) = {team_member_id:String}) OR team_member_id = {team_member_id:String})"
        : "\n  AND team_member_id = {team_member_id:String}"
      : filters.actorUserId
        ? "\n  AND actor_user_id = {actor_user_id:String}"
        : "";
    sql = `SELECT e.id AS event_id, e.occurred_at_ms, e.event_type, e.entity_type, e.entity_id, u.full_name AS actor_name,
  tm.display_name AS member_name, e.source, e.from_status, e.to_status, e.reason
FROM (SELECT * FROM analytics.events WHERE tenant_id = {tenant_id:String}
  AND occurred_at_ms >= {from_ms:Int64} AND occurred_at_ms < {to_ms:Int64}${member}${filters.entityType ? "\n  AND entity_type = {entity_type:String}" : ""}) AS e
LEFT ANY JOIN (SELECT id, full_name FROM analytics.users WHERE tenant_id = {tenant_id:String}) AS u ON u.id = e.actor_user_id
LEFT ANY JOIN (SELECT id, display_name FROM analytics.team_members WHERE tenant_id = {tenant_id:String}) AS tm ON tm.id = e.team_member_id
ORDER BY e.occurred_at_ms, e.id`;
  } else {
    sql = `SELECT m.id AS meeting_id, m.scheduled_at_ms, m.created_at_ms, m.opportunity_id AS deal_id,
  coalesce(nullIf(l.full_name, ''), m.lead_name, '') AS person_name,
  if(ifNull(c.team_member_id, '') = '', ifNull(u.full_name, 'Unknown'), ifNull(tm.display_name, 'Unknown')) AS closer_name,
  ifNull(m.call_classification, 'new') AS call_type,
  multiIf(m.status = 'canceled' AND ifNull(s.replaced_id, '') != '', 'moved', m.status = 'canceled', 'canceled',
    m.status = 'held', 'held', m.status = 'no_show', 'no-show',
    m.scheduled_at_ms + m.duration_minutes * 60000 <= {now_ms:Int64}, 'not recorded', 'upcoming') AS attendance,
  m.rescheduled_from_meeting_id AS replaced_meeting_id
FROM (SELECT * FROM analytics.meetings WHERE tenant_id = {tenant_id:String}
  AND scheduled_at_ms >= {from_ms:Int64} AND scheduled_at_ms < {to_ms:Int64}${filters.programId ? "\n  AND booking_program_id = {program_id:String}" : ""}${filters.callType ? "\n  AND ifNull(call_classification, 'new') = {call_type:String}" : ""}) AS m
LEFT ANY JOIN (SELECT id, lead_id FROM analytics.deals WHERE tenant_id = {tenant_id:String}) AS d ON d.id = m.opportunity_id
LEFT ANY JOIN (SELECT id, full_name FROM analytics.people WHERE tenant_id = {tenant_id:String}) AS l ON l.id = d.lead_id
LEFT ANY JOIN (
  SELECT meeting_id, tupleElement(argMax(tuple(team_member_id), (attributed_at_ms, creation_time_ms, id)), 1) AS team_member_id,
    JSONExtractString(argMax(source_json, (attributed_at_ms, creation_time_ms, id)), 'userId') AS closer_user_id
  FROM analytics.attributions WHERE tenant_id = {tenant_id:String} AND role = 'closer'
  GROUP BY meeting_id
) AS c ON c.meeting_id = m.id
LEFT ANY JOIN (SELECT id, display_name FROM analytics.team_members WHERE tenant_id = {tenant_id:String}) AS tm ON tm.id = c.team_member_id
LEFT ANY JOIN (SELECT id, full_name FROM analytics.users WHERE tenant_id = {tenant_id:String}) AS u ON u.id = m.assigned_closer_id
LEFT ANY JOIN (SELECT rescheduled_from_meeting_id AS replaced_id FROM analytics.meetings
  WHERE tenant_id = {tenant_id:String} AND ifNull(rescheduled_from_meeting_id, '') != '' GROUP BY replaced_id) AS s ON s.replaced_id = m.id${filters.closerId ? "\nWHERE coalesce(nullIf(c.closer_user_id, ''), m.assigned_closer_id) = {closer_id:String}" : ""}
ORDER BY m.scheduled_at_ms, m.id`;
  }
  return { sql: `${sql}\nLIMIT ${MAX_EXPORT_ROWS + 1}\nSETTINGS max_execution_time = 30`,
    params: {
      ...rangeParams(range),
      ...(kind === "calls" ? { now_ms: now } : {}),
      ...(filters.programId ? { program_id: filters.programId } : {}),
      ...(kind === "calls" && filters.callType ? { call_type: filters.callType } : {}),
      ...(kind === "calls" && filters.closerId ? { closer_id: filters.closerId } : {}),
      ...(kind === "events" && filters.teamMemberId ? { team_member_id: filters.teamMemberId } : {}),
      ...(kind === "events" && filters.actorUserId ? { actor_user_id: filters.actorUserId } : {}),
      ...(kind === "events" && filters.entityType ? { entity_type: filters.entityType } : {}),
    } };
}
export function exportRowsFromSql(kind: RowsKind, rows: SqlRow[], timeZone: string): ReportRecord[] {
  if (rows.length > MAX_EXPORT_ROWS) throw tooLarge();
  const iso = (value: unknown) => value === null || value === undefined ? "" : new Date(Number(value)).toISOString();
  const text = (value: unknown) => value === null || value === undefined ? "" : String(value);
  if (kind === "events") {
    return rows.map((row): ReportRecord => ({
      eventId: text(row.event_id), occurredAt: iso(row.occurred_at_ms), timeZone, label: getEventLabel(text(row.event_type)).verb,
      eventType: text(row.event_type), entityType: text(row.entity_type), entityId: text(row.entity_id),
      actorName: text(row.actor_name), memberName: text(row.member_name), source: text(row.source),
      fromStatus: text(row.from_status), toStatus: text(row.to_status), reason: text(row.reason),
    }));
  }
  return rows.map((row): ReportRecord => kind === "calls" ? {
    meetingId: text(row.meeting_id), scheduledAt: iso(row.scheduled_at_ms), createdAt: iso(row.created_at_ms), timeZone,
    dealId: text(row.deal_id), personName: text(row.person_name), closerName: text(row.closer_name), callType: text(row.call_type),
    attendance: text(row.attendance), replacedMeetingId: text(row.replaced_meeting_id),
  } : {
    paymentId: text(row.payment_id), recordedAt: iso(row.recorded_at_ms), timeZone, dealId: text(row.deal_id),
    personName: text(row.person_name), program: text(row.program), type: text(row.type), status: text(row.status),
    currency: text(row.currency), amount: (Number(row.amount_minor) / 100).toFixed(2),
    ...(kind === "credits" ? { teamMemberId: text(row.team_member_id), creditedName: text(row.credited_name), role: text(row.role), teamId: text(row.team_id) }
      : { closerName: text(row.closer_name) }),
  });
}
export const exportContext = internalQuery({ args: { range: datesValidator }, returns: v.object({ tenantId: v.id("tenants"), range: scorecardRangeValidator, todayStart: v.number() }), handler: async (ctx, { range }) => {
  const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
  const setting = await getTenantBusinessDay(ctx, tenantId);
  const resolved = resolveAnalyticsRange({ kind: "custom", ...range }, setting, Date.now());
  return { tenantId, range: resolved, todayStart: businessDayStart(businessDateForInstant(Date.now(), setting), setting) };
} });
async function tenantDoc<Table extends "opportunities" | "leads" | "users" | "teamMembers" | "attributionTeams">(
  ctx: QueryCtx, table: Table, id: Id<Table> | undefined, tenantId: Id<"tenants">, reader: LiveReader,
) {
  if (!id) return null;
  const [doc] = await reader.documents([id], key => ctx.db.get(table, key));
  return doc?.tenantId === tenantId ? doc : null;
}
export const liveRows = internalQuery({ args: { kind: kindValidator, range: scorecardRangeValidator, now: v.number(), filters: v.optional(filtersValidator) }, returns: v.array(rowValidator),
  handler: async (ctx, { kind, range, now, filters = {} }): Promise<ReportRecord[]> => {
    const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
    const reader = liveReader();
    const result: ReportRecord[] = [];
    if (kind === "calls") {
      const meetings = await reader.rows(ctx.db.query("meetings").withIndex("by_tenantId_and_scheduledAt", q =>
        q.eq("tenantId", tenantId).gte("scheduledAt", range.fromMs).lt("scheduledAt", range.toMs)));
      for (const meeting of meetings) {
        if (filters.programId && meeting.bookingProgramId !== filters.programId) continue;
        if (filters.callType && (meeting.callClassification ?? "new") !== filters.callType) continue;
        const deal = await tenantDoc(ctx, "opportunities", meeting.opportunityId, tenantId, reader);
        const person = await tenantDoc(ctx, "leads", deal?.leadId, tenantId, reader);
        const credits = await reader.rows(ctx.db.query("dealAttributions").withIndex("by_tenantId_and_meetingId", q => q.eq("tenantId", tenantId).eq("meetingId", meeting._id)));
        const credit = credits.filter(c => c.role === "closer").sort((a, b) => b.attributedAt - a.attributedAt || b._creationTime - a._creationTime || b._id.localeCompare(a._id))[0];
        const closerAtTheTime = credit && "userId" in credit.source ? credit.source.userId : meeting.assignedCloserId;
        if (filters.closerId && closerAtTheTime !== filters.closerId) continue;
        const member = await tenantDoc(ctx, "teamMembers", credit?.teamMemberId, tenantId, reader);
        const user = await tenantDoc(ctx, "users", meeting.assignedCloserId, tenantId, reader);
        const successor = await ctx.db.query("meetings").withIndex("by_rescheduledFromMeetingId", q => q.eq("rescheduledFromMeetingId", meeting._id)).first();
        const attendance = meetingAttendanceDisplay(meeting, now);
        result.push({ meetingId: meeting._id, scheduledAt: new Date(meeting.scheduledAt).toISOString(), createdAt: new Date(meeting.createdAt).toISOString(),
          timeZone: range.timeZone, dealId: meeting.opportunityId, personName: person?.fullName || meeting.leadName || "",
          closerName: credit?.teamMemberId ? member?.displayName ?? "Unknown" : user?.fullName ?? "Unknown",
          callType: meeting.callClassification ?? "new", attendance: isMovedSlot(meeting, successor?.tenantId === tenantId ? successor : null) ? "moved"
            : attendance === "no_show" ? "no-show" : attendance === "not_recorded" ? "not recorded" : attendance === "scheduled" ? "upcoming" : attendance,
          replacedMeetingId: meeting.rescheduledFromMeetingId ?? "" });
      }
    } else {
      const payments = await reader.rows(ctx.db.query("paymentRecords").withIndex("by_tenantId_and_recordedAt", q =>
        q.eq("tenantId", tenantId).gte("recordedAt", range.fromMs).lt("recordedAt", range.toMs)));
      for (const p of payments) {
        if (filters.programId && p.programId !== filters.programId) continue;
        if (kind === "credits" && p.status === "disputed") continue;
        const deal = await tenantDoc(ctx, "opportunities", p.opportunityId, tenantId, reader);
        const person = await tenantDoc(ctx, "leads", deal?.leadId, tenantId, reader);
        const base: ReportRecord = { paymentId: p._id, recordedAt: new Date(p.recordedAt).toISOString(), timeZone: range.timeZone,
          dealId: p.opportunityId ?? "", personName: person?.fullName ?? "", program: p.programName, type: p.paymentType,
          status: p.status, currency: p.currency, amount: (p.amountMinor / 100).toFixed(2) };
        if (kind === "payments") {
          const closer = await tenantDoc(ctx, "users", p.attributedCloserId, tenantId, reader);
          result.push({ ...base, closerName: closer?.fullName ?? "" });
        } else if (deal) {
          const credits = await reader.rows(ctx.db.query("dealAttributions").withIndex("by_tenantId_and_opportunityId_and_role", q => q.eq("tenantId", tenantId).eq("opportunityId", deal._id)));
          const seen = new Set<string>();
          // The closer is the payment's attributed closer, as on Attribution.
          if (p.attributedCloserId) {
            const user = await tenantDoc(ctx, "users", p.attributedCloserId, tenantId, reader);
            const member = await tenantDoc(ctx, "teamMembers", user?.teamMemberId, tenantId, reader);
            result.push({ ...base, teamMemberId: user?.teamMemberId ?? "", creditedName: member?.displayName ?? user?.fullName ?? "", role: "closer", teamId: "" });
          }
          for (const credit of credits) {
            if (credit.role === "closer" || credit.attributedAt > p.recordedAt) continue;
            const identityId = credit.role === "dm_team" ? credit.teamId : credit.teamMemberId;
            if (!identityId) continue;
            const key = `${identityId}:${credit.role}`;
            if (seen.has(key)) continue; seen.add(key);
            if (credit.role === "dm_team") {
              const team = await tenantDoc(ctx, "attributionTeams", credit.teamId, tenantId, reader);
              result.push({ ...base, teamMemberId: "", creditedName: team?.displayName ?? "Unknown team", role: credit.role, teamId: credit.teamId ?? "" });
            } else {
              const member = await tenantDoc(ctx, "teamMembers", credit.teamMemberId, tenantId, reader);
              result.push({ ...base, teamMemberId: credit.teamMemberId ?? "", creditedName: member?.displayName ?? "", role: credit.role, teamId: "" });
            }
            if (result.length > MAX_EXPORT_ROWS) throw tooLarge();
          }
        }
      }
    }
    return result;
  },
});
/**
 * One page of the live part of an events export. A day holds a few thousand
 * events, more than one bounded read, so the action pages through them.
 */
export const liveEventPage = internalQuery({
  args: { range: scorecardRangeValidator, filters: v.optional(filtersValidator), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ rows: v.array(rowValidator), continueCursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, { range, filters = {}, cursor }) => {
    const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
    const page = await ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_occurredAt", (q) => q.eq("tenantId", tenantId).gte("occurredAt", range.fromMs).lt("occurredAt", range.toMs))
      .paginate({ cursor, numItems: 500 });
    const names = new Map<string, string>();
    const userName = async (id: Id<"users"> | undefined) => {
      if (!id) return "";
      if (!names.has(id)) {
        const user = await ctx.db.get("users", id);
        names.set(id, user?.tenantId === tenantId ? (user.fullName ?? user.email) : "");
      }
      return names.get(id)!;
    };
    const memberName = async (id: Id<"teamMembers"> | undefined) => {
      if (!id) return "";
      if (!names.has(id)) {
        const member = await ctx.db.get("teamMembers", id);
        names.set(id, member?.tenantId === tenantId ? member.displayName : "");
      }
      return names.get(id)!;
    };
    const rows: ReportRecord[] = [];
    for (const event of page.page) {
      if (filters.entityType && event.entityType !== filters.entityType) continue;
      if (filters.teamMemberId) {
        const ownAction = filters.actorUserId !== undefined && event.actorUserId === filters.actorUserId &&
          (event.teamMemberId === undefined || event.teamMemberId === filters.teamMemberId);
        if (!ownAction && event.teamMemberId !== filters.teamMemberId) continue;
      } else if (filters.actorUserId && event.actorUserId !== filters.actorUserId) continue;
      rows.push({
        eventId: event._id, occurredAt: new Date(event.occurredAt).toISOString(), timeZone: range.timeZone,
        label: getEventLabel(event.eventType).verb, eventType: event.eventType, entityType: event.entityType, entityId: event.entityId,
        actorName: await userName(event.actorUserId), memberName: await memberName(event.teamMemberId),
        source: event.source, fromStatus: event.fromStatus ?? "", toStatus: event.toStatus ?? "", reason: event.reason ?? "",
      });
    }
    return { rows, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

export const exportRows = action({ args: { kind: kindValidator, range: datesValidator, filters: v.optional(filtersValidator) }, returns: v.bytes(),
  handler: async (ctx, { kind, range, filters = {} }): Promise<ArrayBuffer> => {
    const viewer = await requireTenantUserFromAction(ctx, [...REPORT_ADMIN_ROLES]);
    const context = await ctx.runQuery(internal.reports.rowsExport.exportContext, { range });
    const now = Date.now();
    // Without a reporting database (a dev deployment), every row is read live.
    let warehouseTo = isClickHouseConfigured() ? Math.min(context.range.toMs, context.todayStart) : context.range.fromMs;
    if (context.range.fromMs < warehouseTo) {
      // Only completed days through the warehouse watermark are historical.
      // Before the first sync after midnight, yesterday remains a live read.
      const watermark = await queryWatermark();
      warehouseTo = watermark === null ? context.range.fromMs : Math.min(warehouseTo,
        businessDayStart(businessDateForInstant(watermark, context.range), context.range));
    }
    warehouseTo = Math.max(context.range.fromMs, warehouseTo);
    let history: ReportRecord[] = [];
    if (context.range.fromMs < warehouseTo) {
      const rows = await queryTenantClickHouse(viewer.tenantId, rowsExportSql(kind, { ...context.range, toMs: warehouseTo }, now, filters));
      history = exportRowsFromSql(kind, rows, context.range.timeZone);
    }
    let live: ReportRecord[] = [];
    if (warehouseTo < context.range.toMs) {
      const liveRange = { ...context.range, fromMs: warehouseTo };
      if (kind === "events") {
        let cursor: string | null = null;
        for (;;) {
          const page: { rows: ReportRecord[]; continueCursor: string; isDone: boolean } = await ctx.runQuery(
            internal.reports.rowsExport.liveEventPage, { range: liveRange, filters, cursor });
          live.push(...page.rows);
          if (history.length + live.length > MAX_EXPORT_ROWS) throw tooLarge();
          if (page.isDone) break;
          cursor = page.continueCursor;
        }
      } else {
        live = await ctx.runQuery(internal.reports.rowsExport.liveRows, { kind, range: liveRange, now, filters });
      }
    }
    return assembleRowsCsv(kind, history, live);
  },
});
