import type { Id } from "../../_generated/dataModel";
import {
  buildPeopleClosers,
  loadCloserUsers,
  type getPeopleClosers,
} from "../../reports/people";
import {
  MEMBER_REPORT_ROLES,
  resolveMemberFilter,
} from "../../reports/lib/access";
import { defineReport, rangeParams, type ReportInput } from "../definition";
import { docsFromRows } from "../rows";
import { callFactsSql, warehouseCallFacts } from "./calls";

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
export const peopleClosers = defineReport<
  typeof getPeopleClosers,
  PeopleCloserFilters
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
    };
  },
  finalize: async (ctx, input) => {
    const facts = await warehouseCallFacts(
      ctx,
      input.tenantId,
      input.rows.meetings ?? [],
    );
    const payments = docsFromRows<"paymentRecords">(input.rows.payments).filter(
      (p) => p.tenantId === input.tenantId,
    );
    const roster = await loadCloserUsers(
      ctx,
      input.tenantId,
      facts,
      payments,
      "warehouse",
    );
    return buildPeopleClosers(
      {
        ...facts,
        partial: facts.partial || roster.partial,
        users: roster.users,
        payments,
        callPayments: docsFromRows<"paymentRecords">(
          input.rows.callPayments,
        ).filter((p) => p.tenantId === input.tenantId),
        cohort: (input.rows.cohort ?? []).map((r) => ({
          meetingId: String(r.meeting_id) as Id<"meetings">,
          won: r.outcome === "won",
        })),
        firstPaymentIds: (input.rows.firstPayments ?? []).map(
          (r) => String(r.payment_id) as Id<"paymentRecords">,
        ),
        cohortPartial: facts.partial,
        paymentsPartial: false,
      },
      input.filters.memberId,
      input.range,
    );
  },
  live: { name: "reports/people:getPeopleClosers", args: liveArgs },
});
export const peopleCloserReports = [peopleClosers];
