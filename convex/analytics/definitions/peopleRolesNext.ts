import { peopleSlot } from "./peopleServing";
import type { Id } from "../../_generated/dataModel";
import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import { MEMBER_REPORT_ROLES, resolveMemberFilter } from "../../reports/lib/access";
import { addMoney, loadCreditDimensions, memberIdentity, teamIdentity, type CreditDimensions, type PeopleRole } from "../../reports/lib/creditFacts";
import { emptyPeopleRoleRow, finishPeopleRoleReport, loadRoleHours, type PeopleRoleReport, type PeopleRoleDay, type PeopleRoleItem, type getLeadGen, type getSetters, type getDmClosers } from "../../reports/peopleRoles";
import type { SqlQuery, SqlRow } from "../clickhouse";
import { defineReport, nodeFinalize, num, rangeParams, str, type NodeBuild } from "../definition";
import type { PeopleRoleFilters, PeopleRoleContext } from "./peopleRoles";
import { VOIDED_CAPTURES } from "./leadGenShared";

type Context = PeopleRoleContext & { nowMs: number };
const day = (at: string) => `toString(toDate(toTimeZone(fromUnixTimestamp64Milli(${at}), {tz:String}) - toIntervalHour({day_start_hour:UInt8})))`;
// Unknown member ids collapse before DISTINCT or GROUP BY. Team fallback has
// its own identity even when a team was deleted, as in attributionIdentity.
const memberKey = (column: string) => `if(has({member_ids:Array(String)}, ifNull(${column}, '')), assumeNotNull(${column}), 'unlinked')`;
const workerKey = (column: string) => `ifNull(nullIf(arrayElement({worker_members:Array(String)}, indexOf({worker_ids:Array(String)}, ifNull(${column}, ''))), ''), 'unlinked')`;
const ids = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];

export function roleAggregateParams(range: ResolvedAnalyticsRange, memberId: Id<"teamMembers"> | null, context: Context) {
  const d = context.dimensions;
  return { ...rangeParams(range), now_ms: context.nowMs, member_key: memberId ?? "", member_filtered: Number(memberId !== null),
    member_ids: d.members.map(m => m._id), team_ids: d.teams.map(t => t._id),
    worker_ids: d.workers.map(w => w._id), worker_members: d.workers.map(w => memberIdentity(d, w.teamMemberId).key),
    slack_user_ids: d.slackUsers.map(u => u.slackUserId), slack_team_ids: d.slackUsers.map(u => u.slackTeamId),
    slack_members: d.slackUsers.map(u => memberIdentity(d, u.teamMemberId).key),
    dm_closer_ids: d.dmClosers.map(c => c._id), dm_closer_members: d.dmClosers.map(c => memberIdentity(d, c.teamMemberId).key),
  };
}

/** All recipient matches survive the ALL JOIN, then payment x resolved identity
 * is deduplicated. ANY is used only for unique view ids or grouped evidence. */
export function roleCreditCtes(role: PeopleRole) {
  return `credits AS (
  SELECT opportunity_id, role, attributed_at_ms, ifNull(meeting_id, '') AS meeting_id,
    if(role = 'dm_team', concat('team:', ifNull(team_id, 'unlinked')), ${memberKey("team_member_id")}) AS identity_key,
    JSONExtractString(ifNull(source_json, '{}'), 'kind') AS source_kind
  FROM analytics.attributions WHERE tenant_id = {tenant_id:String}
    AND role IN (${role === "dm_closer" ? "'dm_closer', 'dm_team'" : `'${role}'`})
), range_payments AS (
  SELECT id, opportunity_id, recorded_at_ms, currency, amount_minor
  FROM analytics.payments WHERE tenant_id = {tenant_id:String}
    AND recorded_at_ms >= {from_ms:Int64} AND recorded_at_ms < {to_ms:Int64}
    AND ifNull(status, '') != 'disputed'
), eligible AS (
  SELECT p.id AS payment_id, p.opportunity_id AS opportunity_id, p.recorded_at_ms AS recorded_at_ms,
    p.currency AS currency, p.amount_minor AS amount_minor, c.identity_key AS identity_key, c.role AS credit_role,
    countIf(c.role = 'dm_closer') OVER (PARTITION BY p.id) AS named_count
  FROM range_payments AS p INNER ALL JOIN credits AS c ON c.opportunity_id = p.opportunity_id
  WHERE c.attributed_at_ms <= p.recorded_at_ms
), recipients AS (
  SELECT DISTINCT payment_id, opportunity_id, recorded_at_ms, currency, amount_minor, identity_key
  FROM eligible${role === "dm_closer" ? " WHERE credit_role = 'dm_closer' OR named_count = 0" : ""}
)`;
}
// Per-status indexed winner first, then the live reader's recordedAt/id tie
// break across statuses. Creation time is deliberately absent in stage two.
export const roleFirstPaymentsCte = `first_payments AS (
  SELECT id, opportunity_id, recorded_at_ms FROM (
    SELECT id, opportunity_id, recorded_at_ms, creation_time_ms, status
    FROM analytics.payments WHERE tenant_id = {tenant_id:String}
      AND opportunity_id IN (SELECT opportunity_id FROM range_payments)
      AND status IN ('recorded', 'verified')
    ORDER BY recorded_at_ms, creation_time_ms, id LIMIT 1 BY opportunity_id, status
  ) ORDER BY recorded_at_ms, id LIMIT 1 BY opportunity_id
)`;
export const roleCashSelect = `SELECT identity_key, currency, sum(amount_minor) AS amount_minor
FROM recipients GROUP BY identity_key, currency`;
export const roleCashDaysSelect = `SELECT ${day("recorded_at_ms")} AS day_key, currency, sum(amount_minor) AS amount_minor
FROM recipients WHERE identity_key = {member_key:String} GROUP BY day_key, currency`;
// ALL: several identities can share one first payment; first_payments ids are unique.
export const roleWinsSelect = `SELECT r.identity_key AS identity_key, groupUniqArray(r.opportunity_id) AS won_deal_ids
FROM recipients AS r INNER ALL JOIN first_payments AS f ON f.id = r.payment_id GROUP BY r.identity_key`;
export const roleFirstPaymentDealsSelect = `SELECT opportunity_id FROM first_payments
WHERE recorded_at_ms >= {from_ms:Int64} AND recorded_at_ms < {to_ms:Int64}
  AND ({member_filtered:UInt8} = 0 OR opportunity_id IN (
    SELECT opportunity_id FROM credits WHERE identity_key = {member_key:String}
  ))`;
export function roleDealSelect(role: PeopleRole) {
  return `SELECT c.identity_key AS identity_key, groupUniqArray(c.opportunity_id) AS deal_ids,
  groupUniqArrayIf(c.opportunity_id, c.source_kind = 'capture') AS capture_deal_ids,
  groupUniqArrayIf(c.opportunity_id, c.source_kind = 'respark') AS respark_deal_ids
FROM credits AS c
WHERE c.attributed_at_ms >= {from_ms:Int64} AND c.attributed_at_ms < {to_ms:Int64}
  ${role === "dm_closer" ? `AND (c.role = 'dm_closer' OR (c.meeting_id != '' AND c.meeting_id NOT IN (
    SELECT meeting_id FROM credits WHERE role = 'dm_closer'
  )))` : ""}
GROUP BY c.identity_key`;
}
const slackKey = `ifNull(nullIf(arrayElement({slack_members:Array(String)}, indexOf(
    arrayZip({slack_user_ids:Array(String)}, {slack_team_ids:Array(String)}),
    (ifNull(slack_user_id, ''), ifNull(slack_team_id, '')))), ''), 'unlinked')`;
export const setterActivityCte = `qualifications AS (
  SELECT id, submitted_at_ms AS at_ms, ${slackKey} AS identity_key,
    result_kind, full_name_snapshot, lead_id, opportunity_id
  FROM analytics.qualifications WHERE tenant_id = {tenant_id:String}
    AND submitted_at_ms >= {from_ms:Int64} AND submitted_at_ms < {to_ms:Int64}
)`;
export const setterActivitySelect = `SELECT identity_key, result_kind, count() AS qualifications
FROM qualifications GROUP BY identity_key, result_kind`;
export const setterDaysSelect = `SELECT ${day("at_ms")} AS day_key, count() AS qualifications
FROM qualifications WHERE identity_key = {member_key:String} GROUP BY day_key`;
export const setterItemsSelect = `SELECT q.id AS id, q.at_ms AS at_ms, q.full_name_snapshot AS person_name,
  q.lead_id AS lead_id, q.opportunity_id AS opportunity_id, q.result_kind AS result,
  nullIf(d.outcome, '') AS outcome, CAST(NULL AS Nullable(Int64)) AS scheduled_at_ms
FROM (SELECT * FROM qualifications WHERE identity_key = {member_key:String} ORDER BY at_ms DESC, id ASC LIMIT 300) AS q
LEFT ANY JOIN (SELECT id, outcome FROM analytics.deals WHERE tenant_id = {tenant_id:String}) AS d ON d.id = q.opportunity_id
ORDER BY q.at_ms DESC, q.id ASC`;
export const setterDealsSelect = `SELECT c.identity_key AS identity_key, groupUniqArray(c.opportunity_id) AS deal_ids,
  groupUniqArrayIf(c.opportunity_id, c.source_kind = 'capture') AS capture_deal_ids,
  groupUniqArrayIf(c.opportunity_id, c.source_kind = 'respark') AS respark_deal_ids,
  groupUniqArrayIf(c.opportunity_id, d.first_booked_at_ms IS NOT NULL OR m.meetings > 0) AS booked_deal_ids,
  groupUniqArrayIf(c.opportunity_id, m.held > 0) AS held_deal_ids,
  groupUniqArrayIf(c.opportunity_id, d.outcome = 'won') AS won_deal_ids
FROM credits AS c
LEFT ANY JOIN (SELECT id, first_booked_at_ms, outcome FROM analytics.deals WHERE tenant_id = {tenant_id:String}) AS d ON d.id = c.opportunity_id
LEFT ANY JOIN (
  SELECT opportunity_id, count() AS meetings, countIf(status = 'held') AS held
  FROM analytics.meetings WHERE tenant_id = {tenant_id:String} GROUP BY opportunity_id
) AS m ON m.opportunity_id = c.opportunity_id
WHERE c.attributed_at_ms >= {from_ms:Int64} AND c.attributed_at_ms < {to_ms:Int64}
GROUP BY c.identity_key`;

export const dmBookingCte = `booking_credits AS (
  SELECT m.id AS id, m.opportunity_id AS opportunity_id, m.created_at_ms AS at_ms,
    m.status AS status, m.scheduled_at_ms AS scheduled_at_ms, m.duration_minutes AS duration_minutes,
    m.lead_name AS lead_name, c.identity_key AS identity_key, c.role AS credit_role,
    countIf(c.role = 'dm_closer') OVER (PARTITION BY m.id) AS named_count
  FROM (
    SELECT id, opportunity_id, created_at_ms, status, scheduled_at_ms, duration_minutes, lead_name
    FROM analytics.meetings WHERE tenant_id = {tenant_id:String}
      AND created_at_ms >= {from_ms:Int64} AND created_at_ms < {to_ms:Int64}
      AND rescheduled_from_meeting_id IS NULL
  ) AS m INNER ALL JOIN credits AS c ON c.meeting_id = m.id
), bookings AS (
  SELECT DISTINCT id, opportunity_id, at_ms, status, scheduled_at_ms, duration_minutes, lead_name, identity_key
  FROM booking_credits WHERE credit_role = 'dm_closer' OR named_count = 0
)`;
export const dmActivitySelect = `SELECT identity_key, count() AS bookings,
  countIf(status = 'held') AS held, countIf(status = 'no_show') AS no_show,
  countIf(status = 'scheduled' AND scheduled_at_ms + duration_minutes * 60000 <= {now_ms:Int64}) AS not_recorded
FROM bookings GROUP BY identity_key`;
export const dmDaysSelect = `SELECT ${day("at_ms")} AS day_key, count() AS bookings
FROM bookings WHERE identity_key = {member_key:String} GROUP BY day_key`;
export const dmItemsSelect = `SELECT m.id AS id, m.at_ms AS at_ms,
  coalesce(if(ifNull(p.id, '') != '', p.full_name, NULL), m.lead_name, 'Unknown person') AS person_name,
  nullIf(d.lead_id, '') AS lead_id, m.opportunity_id AS opportunity_id, m.status AS result,
  nullIf(d.outcome, '') AS outcome, m.scheduled_at_ms AS scheduled_at_ms
FROM (SELECT * FROM bookings WHERE identity_key = {member_key:String} ORDER BY at_ms DESC, id ASC LIMIT 300) AS m
LEFT ANY JOIN (SELECT id, lead_id, outcome FROM analytics.deals WHERE tenant_id = {tenant_id:String}) AS d ON d.id = m.opportunity_id
LEFT ANY JOIN (SELECT id, full_name FROM analytics.people WHERE tenant_id = {tenant_id:String}) AS p ON p.id = d.lead_id
ORDER BY m.at_ms DESC, m.id ASC`;

export const leadGenActivityCtes = `${VOIDED_CAPTURES}, captures AS (
  SELECT c.id AS id, ${workerKey("c.worker_id")} AS identity_key, c.submitted_at_ms AS at_ms,
    c.prospect_id AS prospect_id, c.source AS result, nullIf(p.lead_id, '') AS lead_id
  FROM (
    SELECT id, worker_id, submitted_at_ms, prospect_id, source FROM analytics.captures
    WHERE tenant_id = {tenant_id:String} AND submitted_at_ms >= {from_ms:Int64} AND submitted_at_ms < {to_ms:Int64}
      AND voided_at_ms IS NULL AND id NOT IN (SELECT id FROM voided)
  ) AS c
  LEFT ANY JOIN (SELECT id, lead_id FROM analytics.prospects WHERE tenant_id = {tenant_id:String}) AS p ON p.id = c.prospect_id
), resparks AS (
  SELECT ${workerKey("worker_id")} AS identity_key, worked_at_ms AS at_ms
  FROM analytics.respark_items WHERE tenant_id = {tenant_id:String} AND result = 'resparked'
    AND worked_at_ms >= {from_ms:Int64} AND worked_at_ms < {to_ms:Int64}
)`;
export const leadGenActivitySelect = `SELECT identity_key, count() AS captures, groupUniqArrayIf(lead_id, lead_id IS NOT NULL) AS person_ids, 0 AS resparks
FROM captures GROUP BY identity_key
UNION ALL SELECT identity_key, 0 AS captures, [] AS person_ids, count() AS resparks FROM resparks GROUP BY identity_key`;
export const leadGenDaysSelect = `SELECT ${day("at_ms")} AS day_key, count() AS captures, 0 AS resparks
FROM captures WHERE identity_key = {member_key:String} GROUP BY day_key
UNION ALL SELECT ${day("at_ms")} AS day_key, 0 AS captures, count() AS resparks
FROM resparks WHERE identity_key = {member_key:String} GROUP BY day_key`;
export const leadGenItemsSelect = `SELECT c.id AS id, c.at_ms AS at_ms, coalesce(if(ifNull(p.id, '') != '', p.full_name, NULL), 'Unknown person') AS person_name,
  c.lead_id AS lead_id, CAST(NULL AS Nullable(String)) AS opportunity_id, c.result AS result,
  CAST(NULL AS Nullable(String)) AS outcome, CAST(NULL AS Nullable(Int64)) AS scheduled_at_ms
FROM (SELECT * FROM captures WHERE identity_key = {member_key:String} ORDER BY at_ms DESC, id ASC LIMIT 300) AS c
LEFT ANY JOIN (SELECT id, full_name FROM analytics.people WHERE tenant_id = {tenant_id:String}) AS p ON p.id = c.lead_id
ORDER BY c.at_ms DESC, c.id ASC`;

export function roleAggregateSql(range: ResolvedAnalyticsRange, role: PeopleRole, memberId: Id<"teamMembers"> | null, context: Context): Record<string, SqlQuery> {
  const params = roleAggregateParams(range, memberId, context);
  const credits = roleCreditCtes(role);
  const query = (ctes: string, select: string): SqlQuery => ({ sql: `WITH ${ctes}\n${select}`, params });
  const result: Record<string, SqlQuery> = {
    cash: query(credits, roleCashSelect), deals: query(credits, role === "setter" ? setterDealsSelect : roleDealSelect(role)),
    ...(role !== "setter" ? { wins: query(`${credits}, ${roleFirstPaymentsCte}`, roleWinsSelect),
      firstPaymentDeals: query(`${credits}, ${roleFirstPaymentsCte}`, roleFirstPaymentDealsSelect) } : {}),
  };
  if (memberId) result.cashDays = query(credits, roleCashDaysSelect);
  if (role === "lead_gen") {
    result.activity = query(leadGenActivityCtes, leadGenActivitySelect);
    if (memberId) {
      result.days = query(leadGenActivityCtes, leadGenDaysSelect);
      result.items = query(leadGenActivityCtes, leadGenItemsSelect);
    }
  }
  if (role === "setter") {
    result.activity = query(setterActivityCte, setterActivitySelect);
    if (memberId) {
      result.days = query(setterActivityCte, setterDaysSelect);
      result.items = query(setterActivityCte, setterItemsSelect);
    }
  }
  if (role === "dm_closer") {
    const bookingCtes = `${credits}, ${dmBookingCte}`;
    result.activity = query(bookingCtes, dmActivitySelect);
    if (memberId) {
      result.days = query(bookingCtes, dmDaysSelect);
      result.items = query(bookingCtes, dmItemsSelect);
    }
  }
  return result;
}

const counters = { qualifications: "qualifications", bookings: "bookings", held: "held", noShow: "no_show", notRecorded: "not_recorded", captures: "captures", resparks: "resparks" } as const;
const sets = { dealIds: "deal_ids", bookedDealIds: "booked_deal_ids", heldDealIds: "held_deal_ids", wonDealIds: "won_deal_ids", personIds: "person_ids", captureDealIds: "capture_deal_ids", resparkDealIds: "respark_deal_ids" } as const;
function identityFromKey(d: CreditDimensions, key: string) {
  return key.startsWith("team:") ? teamIdentity(d, key.slice(5) === "unlinked" ? undefined : key.slice(5) as Id<"attributionTeams">)
    : memberIdentity(d, key as Id<"teamMembers">);
}
export function roleAggregateNode(role: PeopleRole): NodeBuild<PeopleRoleFilters, PeopleRoleReport, Context> {
  return {
    context: async (ctx, input) => {
      const dimensions = await loadCreditDimensions(ctx, input.tenantId);
      const hours = await loadRoleHours(ctx, input.tenantId, dimensions, role, input.range);
      return { dimensions, hours: { ...hours, byKey: [...hours.byKey] }, nowMs: Date.now() };
    },
    build: input => {
      const rows = new Map<string, ReturnType<typeof emptyPeopleRoleRow>>();
      function row(r: SqlRow) {
        const key = String(r.identity_key);
        if (!rows.has(key)) rows.set(key, emptyPeopleRoleRow(identityFromKey(input.context.dimensions, key)));
        return rows.get(key)!;
      }
      for (const r of [...input.rows.deals ?? [], ...input.rows.wins ?? [], ...input.rows.activity ?? []]) {
        const target = row(r);
        for (const [key, column] of Object.entries(counters)) target[key as keyof typeof counters] += num(r[column]);
        for (const [key, column] of Object.entries(sets)) target[key as keyof typeof sets].push(...ids(r[column]));
        if (r.result_kind !== undefined) target.qualificationsByResult[String(r.result_kind)] = num(r.qualifications);
      }
      for (const r of input.rows.cash ?? []) addMoney(row(r).byCurrency, String(r.currency), num(r.amount_minor));
      const days = new Map<string, PeopleRoleDay>();
      function getDay(r: SqlRow) {
        const dayKey = String(r.day_key);
        if (!days.has(dayKey)) days.set(dayKey, { dayKey, qualifications: 0, bookings: 0, captures: 0, resparks: 0, cashMinorByCurrency: [] });
        return days.get(dayKey)!;
      }
      if (input.filters.memberId) {
        for (const r of input.rows.days ?? []) {
          const target = getDay(r);
          for (const key of ["qualifications", "bookings", "captures", "resparks"] as const) target[key] += num(r[key]);
        }
        for (const r of input.rows.cashDays ?? []) addMoney(getDay(r).cashMinorByCurrency, String(r.currency), num(r.amount_minor));
      }
      const items: PeopleRoleItem[] = input.filters.memberId ? (input.rows.items ?? []).map(r => ({
        id: String(r.id), at: num(r.at_ms), personName: String(r.person_name), leadId: str(r.lead_id) as Id<"leads"> | null,
        opportunityId: str(r.opportunity_id) as Id<"opportunities"> | null, result: String(r.result), outcome: str(r.outcome),
        scheduledAt: r.scheduled_at_ms === null || r.scheduled_at_ms === undefined ? null : num(r.scheduled_at_ms),
      })) : [];
      return finishPeopleRoleReport(input.context.dimensions, { rows: [...rows.values()], days: [...days.values()], items,
        firstPaymentDealIds: (input.rows.firstPaymentDeals ?? []).map(r => String(r.opportunity_id)), isTruncated: false },
      role, input.filters.memberId, { ...input.context.hours, byKey: new Map(input.context.hours.byKey) });
    },
  };
}
const leadGenNode = roleAggregateNode("lead_gen");
export const peopleLeadGenNext = defineReport<typeof getLeadGen, PeopleRoleFilters, Context>({
  ...peopleSlot("lead_gen", "aggregate"), roles: MEMBER_REPORT_ROLES, day: "business",
  parseFilters: async (ctx, raw, viewer) => ({ memberId: await resolveMemberFilter(ctx, raw.memberId, viewer) }),
  sql: (input, context) => {
    if (!context) throw new Error("Role aggregate context must load before SQL.");
    return roleAggregateSql(input.range, "lead_gen", input.filters.memberId, context);
  },
  node: leadGenNode, finalize: nodeFinalize(leadGenNode),
  live: { name: "reports/peopleRoles:getLeadGen", args: input => ({ startDate: input.range.fromMs, endDate: input.range.toMs,
    ...(input.filters.memberId ? { memberId: input.filters.memberId } : {}) }) },
});

const setterNode = roleAggregateNode("setter");
export const peopleSettersNext = defineReport<typeof getSetters, PeopleRoleFilters, Context>({
  ...peopleSlot("setters", "aggregate"), roles: MEMBER_REPORT_ROLES, day: "business",
  parseFilters: async (ctx, raw, viewer) => ({ memberId: await resolveMemberFilter(ctx, raw.memberId, viewer) }),
  sql: (input, context) => {
    if (!context) throw new Error("Role aggregate context must load before SQL.");
    return roleAggregateSql(input.range, "setter", input.filters.memberId, context);
  },
  node: setterNode, finalize: nodeFinalize(setterNode),
  live: { name: "reports/peopleRoles:getSetters", args: input => ({ startDate: input.range.fromMs, endDate: input.range.toMs,
    ...(input.filters.memberId ? { memberId: input.filters.memberId } : {}) }) },
});

const dmNode = roleAggregateNode("dm_closer");
export const peopleDmClosersNext = defineReport<typeof getDmClosers, PeopleRoleFilters, Context>({
  ...peopleSlot("dm_closers", "aggregate"), roles: MEMBER_REPORT_ROLES, day: "business",
  parseFilters: async (ctx, raw, viewer) => ({ memberId: await resolveMemberFilter(ctx, raw.memberId, viewer) }),
  sql: (input, context) => {
    if (!context) throw new Error("Role aggregate context must load before SQL.");
    return roleAggregateSql(input.range, "dm_closer", input.filters.memberId, context);
  },
  node: dmNode, finalize: nodeFinalize(dmNode),
  live: { name: "reports/peopleRoles:getDmClosers", args: input => ({ startDate: input.range.fromMs, endDate: input.range.toMs,
    ...(input.filters.memberId ? { memberId: input.filters.memberId } : {}) }) },
});
