import { peopleClosersNext } from "./peopleClosersNext";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  buildPeopleClosers,
  type getPeopleClosers,
} from "../../reports/people";
import {
  MEMBER_REPORT_ROLES,
  resolveMemberFilter,
} from "../../reports/lib/access";
import { defineReport, nodeFinalize, rangeParams, type NodeBuild, type ReaderOutput, type ReportInput } from "../definition";
import { docsFromRows } from "../rows";
import type { SqlRow } from "../clickhouse";
import { callCloserKeys, callFactsSql, buildWarehouseCallFacts, loadCallUsers } from "./calls";

export type PeopleCloserFilters = { memberId: Id<"teamMembers"> | null };
// The cohort is anchored to the first held call over all time. Filtering the
// range before argMin would count a later follow-up as a new cohort deal.
export const closerCohortSql = `
SELECT f.meeting_id, d.outcome
FROM (
  SELECT opportunity_id,
    argMin(id, (scheduled_at_ms, creation_time_ms, id)) AS meeting_id,
    min(scheduled_at_ms) AS first_held_at_ms
  FROM analytics.meetings
  WHERE tenant_id = {tenant_id:String} AND status = 'held'
  GROUP BY opportunity_id
  HAVING first_held_at_ms >= {from_ms:Int64} AND first_held_at_ms < {to_ms:Int64}
) AS f
INNER ANY JOIN (
  SELECT id, outcome FROM analytics.deals WHERE tenant_id = {tenant_id:String}
) AS d ON d.id = f.opportunity_id`;

/**
 * Deals whose first eligible payment falls in the range, with every closer
 * who ever had a payment on them, so a member answer keeps only its own deals
 * (the live reader's rule) and the merge can retract a win that moved.
 */
export const firstPaymentDealsSql = `
SELECT f.opportunity_id AS opportunity_id, groupUniqArrayIf(p.attributed_closer_id, p.attributed_closer_id IS NOT NULL) AS closer_ids
FROM (
  SELECT opportunity_id, min(recorded_at_ms) AS first_paid_at_ms
  FROM analytics.payments
  WHERE tenant_id = {tenant_id:String} AND ifNull(status, '') != 'disputed' AND opportunity_id IS NOT NULL
  GROUP BY opportunity_id
  HAVING first_paid_at_ms >= {from_ms:Int64} AND first_paid_at_ms < {to_ms:Int64}
) AS f
INNER JOIN (
  SELECT opportunity_id, attributed_closer_id FROM analytics.payments WHERE tenant_id = {tenant_id:String}
) AS p ON p.opportunity_id = f.opportunity_id
GROUP BY f.opportunity_id`;
function firstPaymentDealIds(rows: SqlRow[], users: Doc<"users">[], memberId: Id<"teamMembers"> | null): Id<"opportunities">[] {
  const member = new Set(users.filter(u => memberId !== null && u.teamMemberId === memberId).map(u => String(u._id)));
  return rows
    .filter(r => memberId === null || (r.closer_ids as string[]).some(id => member.has(id)))
    .map(r => String(r.opportunity_id) as Id<"opportunities">);
}

export const firstPaymentSql = `
SELECT argMin(id, (recorded_at_ms, creation_time_ms, id)) AS payment_id,
  min(recorded_at_ms) AS first_paid_at_ms
FROM analytics.payments
WHERE tenant_id = {tenant_id:String} AND ifNull(status, '') != 'disputed' AND opportunity_id IS NOT NULL
GROUP BY opportunity_id
HAVING first_paid_at_ms >= {from_ms:Int64} AND first_paid_at_ms < {to_ms:Int64}`;

function liveArgs(input: ReportInput<PeopleCloserFilters>) {
  return {
    startDate: input.range.fromMs,
    endDate: input.range.toMs,
    ...(input.filters.memberId ? { memberId: input.filters.memberId } : {}),
  };
}
export const CLOSER_QUERY_NAMES = ["meetings", "payments", "callPayments", "cohort", "firstPayments", "firstPaymentDeals"] as const;
type CloserContext = { users: Doc<"users">[] };
const closerNode: NodeBuild<PeopleCloserFilters, ReaderOutput<typeof getPeopleClosers>, CloserContext> = {
  keys: rows => [...new Set([...callCloserKeys(rows), ...docsFromRows<"paymentRecords">(rows.payments)
    .flatMap(payment => payment.attributedCloserId ? [payment.attributedCloserId] : [])])],
  context: async (ctx, input, keys) => {
    const roster = await ctx.db.query("users").withIndex("by_tenantId", q => q.eq("tenantId", input.tenantId)).take(501);
    if (roster.length > 500) throw new Error("The closer roster exceeds the report limit.");
    const byId = new Map(roster.map(user => [user._id, user]));
    for (const user of await loadCallUsers(ctx, input.tenantId, keys.filter(key => !byId.has(key as Id<"users">)))) byId.set(user._id, user);
    return { users: [...byId.values()] };
  },
  build: input => {
    const facts = buildWarehouseCallFacts(input.tenantId, input.rows.meetings ?? [], input.context.users);
    return buildPeopleClosers({
      ...facts, users: input.context.users,
      payments: docsFromRows<"paymentRecords">(input.rows.payments).filter(p => p.tenantId === input.tenantId),
      callPayments: docsFromRows<"paymentRecords">(input.rows.callPayments).filter(p => p.tenantId === input.tenantId),
      cohort: (input.rows.cohort ?? []).map(r => ({ meetingId: String(r.meeting_id) as Id<"meetings">, won: r.outcome === "won" })),
      firstPaymentIds: (input.rows.firstPayments ?? []).map(r => String(r.payment_id) as Id<"paymentRecords">),
      firstPaymentDealIds: firstPaymentDealIds(input.rows.firstPaymentDeals ?? [], input.context.users, input.filters.memberId),
      cohortPartial: facts.partial, paymentsPartial: false,
    }, input.filters.memberId, input.range);
  },
};
export const peopleClosers = defineReport<
  typeof getPeopleClosers,
  PeopleCloserFilters,
  CloserContext
>({
  id: "people.closers",
  page: "people",
  roles: MEMBER_REPORT_ROLES,
  day: "business",
  parseFilters: async (ctx, raw, viewer) => ({
    memberId: await resolveMemberFilter(ctx, raw.memberId, viewer),
  }),
  sql: (input) => {
    const params = rangeParams(input.range);
    return {
      meetings: { sql: callFactsSql, params },
      payments: {
        sql: `SELECT * FROM analytics.payments WHERE tenant_id = {tenant_id:String}
  AND recorded_at_ms >= {from_ms:Int64} AND recorded_at_ms < {to_ms:Int64} AND ifNull(status, '') != 'disputed'`,
        params,
      },
      callPayments: {
        sql: `SELECT * FROM analytics.payments WHERE tenant_id = {tenant_id:String}
  AND ifNull(status, '') != 'disputed' AND meeting_id IN (
    SELECT id FROM analytics.meetings WHERE tenant_id = {tenant_id:String}
      AND scheduled_at_ms >= {from_ms:Int64} AND scheduled_at_ms < {to_ms:Int64}
  )`,
        params,
      },
      cohort: { sql: closerCohortSql, params },
      firstPayments: { sql: firstPaymentSql, params },
      firstPaymentDeals: { sql: firstPaymentDealsSql, params },
    };
  },
  node: closerNode,
  finalize: nodeFinalize(closerNode),
  live: { name: "reports/people:getPeopleClosers", args: liveArgs },
});
export const peopleCloserReports = [peopleClosers, peopleClosersNext];
