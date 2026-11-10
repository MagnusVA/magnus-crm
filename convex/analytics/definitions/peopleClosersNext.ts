import { peopleSlot } from "./peopleServing";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  emptyCloserTotals, finishPeopleClosers,
  type CloserCall, type CloserDay, type CloserTotals, type getPeopleClosers,
} from "../../reports/people";
import { MEMBER_REPORT_ROLES, resolveMemberFilter } from "../../reports/lib/access";
import type { SqlRow } from "../clickhouse";
import { defineReport, nodeFinalize, num, rangeParams, str, type NodeBuild, type ReaderOutput } from "../definition";
import { callEvidenceJoinsSql } from "./calls";
import type { PeopleCloserFilters } from "./people";

// Evidence inputs are tenant-filtered. Credits use argMax's full live-reader
// ordering; other ANY inputs have unique view ids or one grouped row per id.
export const closerFactsCte = `facts AS (
  SELECT m.id AS meeting_id, m.opportunity_id AS opportunity_id,
    m.scheduled_at_ms AS scheduled_at_ms, m.creation_time_ms AS creation_time_ms,
    coalesce(nullIf(c.closer_id, ''), m.assigned_closer_id) AS closer_id,
    m.status != 'canceled' AND (m.status IN ('held', 'no_show') OR
      m.scheduled_at_ms + m.duration_minutes * 60000 <= {now_ms:Int64}) AS due,
    multiIf(m.status = 'canceled' AND s.successor_count > 0, 'moved',
      m.status = 'scheduled', if(due, 'not_recorded', 'upcoming'), m.status) AS call_status,
    ifNull(m.call_classification, 'new') AS call_type,
    toInt64(trunc((toInt64(ifNull(coalesce(m.held_marked_at_ms, m.no_show_marked_at_ms), 0))
      - toInt64(m.scheduled_at_ms) - toFloat64(m.duration_minutes) * 60000) / 60000)) AS record_minutes,
    coalesce(m.held_marked_at_ms, m.no_show_marked_at_ms) IS NOT NULL AS has_record_time,
    coalesce(m.lead_name, nullIf(person.full_name, ''), 'Unknown person') AS lead_name,
    ifNull(m.booking_program_name, 'Unknown program') AS program_name,
    nullIf(d.outcome, '') AS deal_outcome
  FROM (
    SELECT * FROM analytics.meetings WHERE tenant_id = {tenant_id:String}
      AND scheduled_at_ms >= {from_ms:Int64} AND scheduled_at_ms < {to_ms:Int64}
  ) AS m${callEvidenceJoinsSql}
)`;
export const closerFirstPaymentsCte = `first_payments AS (
  SELECT opportunity_id, argMin(id, (recorded_at_ms, creation_time_ms, id)) AS payment_id,
    min(recorded_at_ms) AS first_paid_at_ms
  FROM analytics.payments
  WHERE tenant_id = {tenant_id:String} AND ifNull(status, '') != 'disputed' AND opportunity_id IS NOT NULL
  GROUP BY opportunity_id
  HAVING first_paid_at_ms >= {from_ms:Int64} AND first_paid_at_ms < {to_ms:Int64}
)`;
const day = (at: string) => `toString(toDate(toTimeZone(fromUnixTimestamp64Milli(${at}), {tz:String}) - toIntervalHour({day_start_hour:UInt8})))`;
const memberCalls = `closer_id IN {member_user_ids:Array(String)}`;

export const closerTotalsSql = `WITH ${closerFactsCte}
SELECT closer_id, countIf(due) AS due, countIf(call_status = 'held') AS held,
  countIf(call_status = 'no_show') AS no_show, countIf(call_status = 'not_recorded') AS not_recorded,
  countIf(call_status = 'moved') AS moved, countIf(call_status = 'canceled') AS canceled,
  countIf(call_type = 'new' AND call_status = 'held') AS first_held,
  countIf(call_type = 'new' AND call_status = 'no_show') AS first_no_show,
  countIf(call_type = 'new' AND call_status = 'not_recorded') AS first_not_recorded,
  countIf(call_type != 'new' AND call_status = 'held') AS follow_up_held,
  countIf(call_type != 'new' AND call_status = 'no_show') AS follow_up_no_show,
  arrayMap(x -> x.4, arraySort(x -> (x.1, x.2, x.3), groupArrayIf(
    (scheduled_at_ms, creation_time_ms, meeting_id, record_minutes),
    call_status != 'moved' AND has_record_time))) AS record_minutes
FROM (SELECT * FROM facts ORDER BY scheduled_at_ms, creation_time_ms, meeting_id)
GROUP BY closer_id`;
export const closerCashSql = `WITH ${closerFirstPaymentsCte}
SELECT ifNull(p.attributed_closer_id, '') AS closer_id, p.currency AS currency,
  sum(p.amount_minor) AS cash_minor, sumIf(p.amount_minor, p.payment_type != 'deposit') AS final_minor,
  count() AS payments, groupUniqArrayIf(p.opportunity_id, f.payment_id != '') AS won_deal_ids
FROM (
  SELECT * FROM analytics.payments WHERE tenant_id = {tenant_id:String}
    AND recorded_at_ms >= {from_ms:Int64} AND recorded_at_ms < {to_ms:Int64} AND ifNull(status, '') != 'disputed'
) AS p
LEFT ANY JOIN first_payments AS f ON f.payment_id = p.id
GROUP BY closer_id, p.currency`;
export const closerCohortTotalsSql = `WITH ${closerFactsCte}, first_held AS (
  SELECT opportunity_id, argMin(id, (scheduled_at_ms, creation_time_ms, id)) AS meeting_id,
    min(scheduled_at_ms) AS first_held_at_ms
  FROM analytics.meetings WHERE tenant_id = {tenant_id:String} AND status = 'held'
  GROUP BY opportunity_id
  HAVING first_held_at_ms >= {from_ms:Int64} AND first_held_at_ms < {to_ms:Int64}
)
SELECT f.closer_id AS closer_id, count() AS cohort_deals, countIf(f.deal_outcome = 'won') AS cohort_won
FROM facts AS f INNER ANY JOIN first_held AS h ON h.meeting_id = f.meeting_id
WHERE f.deal_outcome IS NOT NULL GROUP BY f.closer_id`;
export const closerFirstPaymentDealsSql = `WITH ${closerFirstPaymentsCte}
SELECT opportunity_id FROM first_payments
WHERE {member_filtered:UInt8} = 0 OR opportunity_id IN (
  SELECT opportunity_id FROM analytics.payments
  WHERE tenant_id = {tenant_id:String} AND attributed_closer_id IN {member_user_ids:Array(String)}
  GROUP BY opportunity_id
)`;
export const closerCallDaysSql = `WITH ${closerFactsCte}
SELECT ${day("scheduled_at_ms")} AS day_key,
  countIf(call_status = 'held') AS held, countIf(call_status = 'no_show') AS no_show,
  countIf(call_status = 'not_recorded') AS not_recorded
FROM facts WHERE ${memberCalls} GROUP BY day_key`;
export const closerCashDaysSql = `SELECT ${day("recorded_at_ms")} AS day_key, currency, sum(amount_minor) AS cash_minor
FROM analytics.payments WHERE tenant_id = {tenant_id:String}
  AND recorded_at_ms >= {from_ms:Int64} AND recorded_at_ms < {to_ms:Int64} AND ifNull(status, '') != 'disputed'
  AND attributed_closer_id IN {member_user_ids:Array(String)}
GROUP BY day_key, currency`;
export const closerRecentCallsSql = `WITH ${closerFactsCte}, recent AS (
  SELECT * FROM facts WHERE ${memberCalls}
  ORDER BY scheduled_at_ms DESC, meeting_id ASC LIMIT 301
), paid AS (
  SELECT meeting_id, groupArray((currency, paid_minor)) AS paid_minor
  FROM (
    SELECT meeting_id, currency, sum(amount_minor) AS paid_minor
    FROM analytics.payments WHERE tenant_id = {tenant_id:String} AND ifNull(status, '') != 'disputed'
      AND meeting_id IN (SELECT meeting_id FROM recent)
    GROUP BY meeting_id, currency
  ) GROUP BY meeting_id
)
SELECT r.meeting_id AS meeting_id, r.opportunity_id AS opportunity_id, r.scheduled_at_ms AS scheduled_at_ms,
  r.lead_name AS lead_name, r.program_name AS program_name, r.call_status AS call_status,
  r.call_type AS call_type, r.deal_outcome AS deal_outcome, p.paid_minor AS paid_minor
FROM recent AS r LEFT ANY JOIN paid AS p ON p.meeting_id = r.meeting_id
ORDER BY r.scheduled_at_ms DESC, r.meeting_id ASC`;

type Context = { users: Doc<"users">[]; nowMs: number };
const ids = (value: unknown) => (Array.isArray(value) ? value.map(String) : []) as Id<"opportunities">[];
const counters = {
  due: "due", held: "held", noShow: "no_show", notRecorded: "not_recorded", moved: "moved", canceled: "canceled",
  firstHeld: "first_held", firstNoShow: "first_no_show", firstNotRecorded: "first_not_recorded",
  followUpHeld: "follow_up_held", followUpNoShow: "follow_up_no_show",
} as const;
const closerAggregateNode: NodeBuild<PeopleCloserFilters, ReaderOutput<typeof getPeopleClosers>, Context> = {
  // No keys: the small directory loads first so member filtering precedes LIMIT.
  context: async (ctx, input) => {
    const users = await ctx.db.query("users").withIndex("by_tenantId", q => q.eq("tenantId", input.tenantId)).take(501);
    if (users.length > 500) throw new Error("The closer roster exceeds the report limit.");
    return { users, nowMs: Date.now() };
  },
  build: input => {
    const totals = new Map<Id<"users">, CloserTotals>();
    const get = (row: SqlRow) => {
      const id = String(row.closer_id) as Id<"users">;
      if (!totals.has(id)) totals.set(id, emptyCloserTotals(id));
      return totals.get(id)!;
    };
    for (const r of input.rows.totals ?? []) {
      const row = get(r);
      for (const [key, column] of Object.entries(counters)) row[key as keyof typeof counters] = num(r[column]);
      row.recordMinutes = Array.isArray(r.record_minutes) ? r.record_minutes.map(num) : [];
    }
    const unattributedCash = [];
    for (const r of input.rows.cash ?? []) {
      const cash = { currency: String(r.currency), cashMinor: num(r.cash_minor), finalMinor: num(r.final_minor) };
      if (!str(r.closer_id)) { if (!input.filters.memberId) unattributedCash.push(cash); continue; }
      const row = get(r);
      row.cash.push(cash); row.payments += num(r.payments);
      row.wonDealIds!.push(...ids(r.won_deal_ids));
      row.dealsWon = new Set(row.wonDealIds).size;
    }
    for (const r of input.rows.cohort ?? []) {
      const row = get(r); row.cohortDeals = num(r.cohort_deals); row.cohortWon = num(r.cohort_won);
    }
    const days = new Map<string, CloserDay>();
    const getDay = (key: unknown) => {
      const dayKey = String(key);
      if (!days.has(dayKey)) days.set(dayKey, { dayKey, held: 0, noShow: 0, notRecorded: 0, cashMinorByCurrency: [] });
      return days.get(dayKey)!;
    };
    if (input.filters.memberId) {
      for (const r of input.rows.callDays ?? []) Object.assign(getDay(r.day_key), { held: num(r.held), noShow: num(r.no_show), notRecorded: num(r.not_recorded) });
      for (const r of input.rows.cashDays ?? []) getDay(r.day_key).cashMinorByCurrency.push({ currency: String(r.currency), cashMinor: num(r.cash_minor) });
    }
    const calls: CloserCall[] = input.filters.memberId ? (input.rows.calls ?? []).map(r => ({
      meetingId: String(r.meeting_id) as Id<"meetings">, opportunityId: String(r.opportunity_id) as Id<"opportunities">,
      scheduledAt: num(r.scheduled_at_ms), leadName: String(r.lead_name), programName: String(r.program_name),
      status: r.call_status as CloserCall["status"], callType: r.call_type as CloserCall["callType"],
      dealOutcome: (str(r.deal_outcome) ?? null) as CloserCall["dealOutcome"],
      paidMinor: (Array.isArray(r.paid_minor) ? r.paid_minor as [string, unknown][] : [])
        .map(([currency, amount]) => ({ currency, paidMinor: num(amount) })).sort((a, b) => a.currency.localeCompare(b.currency)),
    })) : [];
    return finishPeopleClosers({ users: input.context.users, totals: [...totals.values()], unattributedCash,
      days: [...days.values()], calls, firstPaymentDealIds: (input.rows.firstPaymentDeals ?? []).map(r => String(r.opportunity_id) as Id<"opportunities">),
      partial: false, cohortPartial: false, paymentsPartial: false,
    }, input.filters.memberId);
  },
};
export const peopleClosersNext = defineReport<typeof getPeopleClosers, PeopleCloserFilters, Context>({
  ...peopleSlot("closers", "aggregate"), roles: MEMBER_REPORT_ROLES, day: "business",
  parseFilters: async (ctx, raw, viewer) => ({ memberId: await resolveMemberFilter(ctx, raw.memberId, viewer) }),
  sql: (input, context) => {
    if (!context) throw new Error("Closer aggregate context must load before SQL.");
    const params = { ...rangeParams(input.range), now_ms: context.nowMs,
      member_filtered: Number(!!input.filters.memberId),
      member_user_ids: input.filters.memberId ? context.users.filter(u => u.teamMemberId === input.filters.memberId).map(u => u._id) : [],
    };
    return {
      totals: { sql: closerTotalsSql, params }, cash: { sql: closerCashSql, params },
      cohort: { sql: closerCohortTotalsSql, params }, firstPaymentDeals: { sql: closerFirstPaymentDealsSql, params },
      ...(input.filters.memberId ? { callDays: { sql: closerCallDaysSql, params }, cashDays: { sql: closerCashDaysSql, params }, calls: { sql: closerRecentCallsSql, params } } : {}),
    };
  },
  node: closerAggregateNode, finalize: nodeFinalize(closerAggregateNode),
  live: { name: "reports/people:getPeopleClosers", args: input => ({ startDate: input.range.fromMs, endDate: input.range.toMs,
    ...(input.filters.memberId ? { memberId: input.filters.memberId } : {}) }) },
});
