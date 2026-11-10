import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { LIFECYCLE_STAGES } from "../../leads/lifecycle";
import { REPORT_ADMIN_ROLES } from "../../reports/lib/access";
import { emptyLifecycle, type AnswerFacts, type ScorecardFacts } from "../../reports/lib/scorecardFacts";
import {
  answerLabel, buildAnswers, buildCash, buildFollowThrough, buildFunnel, buildOrigins, normalizeFieldKey,
  type FunnelOutput, type answers, type cash, type followThrough, type funnel, type origins,
} from "../../reports/scorecard";
import { defineReport, nodeFinalize, num, type NodeBuild, optionalIdFilter, rangeParams, type AnalyticsFilters, type ReportInput } from "../definition";
import { docsFromRows } from "../rows";
import type { SqlQuery, SqlRow } from "../clickhouse";

type Filters = { programId: Id<"tenantPrograms"> | null };
type AnswerFilters = Filters & { fieldKey: string };
async function parseFilters(ctx: QueryCtx, raw: AnalyticsFilters): Promise<Filters> {
  const programId = optionalIdFilter(ctx, "tenantPrograms", raw.programId);
  return { programId };
}
const rangePayments = `SELECT * FROM analytics.payments
WHERE tenant_id = {tenant_id:String}
  AND recorded_at_ms >= {from_ms:Int64} AND recorded_at_ms < {to_ms:Int64}`;
function factsSql(input: ReportInput<Filters>, meetings = false): Record<string, SqlQuery> {
  const params = rangeParams(input.range);
  return {
    payments: { sql: rangePayments, params },
    deals: { sql: `SELECT * FROM analytics.deals
WHERE tenant_id = {tenant_id:String}
  AND id IN (SELECT opportunity_id FROM (${rangePayments}))`, params },
    ...(meetings ? { meetings: { sql: `SELECT * FROM analytics.meetings
WHERE tenant_id = {tenant_id:String}
  AND ((created_at_ms >= {from_ms:Int64} AND created_at_ms < {to_ms:Int64})
    OR (scheduled_at_ms >= {from_ms:Int64} AND scheduled_at_ms < {to_ms:Int64}))`, params } } : {}),
  };
}
const factsFromRows = (rows: Record<string, SqlRow[]>): ScorecardFacts => ({
  payments: docsFromRows<"paymentRecords">(rows.payments), deals: docsFromRows<"opportunities">(rows.deals), meetings: docsFromRows<"meetings">(rows.meetings),
});
const stageTime = (stage: string) => `JSONExtract(ifNull(lifecycle_stage_entered_at_json, '{}'), '${stage}', 'Nullable(Float64)')`;
const entryInRange = (stage: string) => `${stageTime(stage)} >= {from_ms:Int64} AND ${stageTime(stage)} < {to_ms:Int64}`;
export const FUNNEL_DEAL_COLUMNS = ["id", "payment_received_at_ms", "first_booking_program_id"] as const;
export const FUNNEL_MEETING_COLUMNS = ["id", "booking_program_id", "created_at_ms", "rescheduled_from_meeting_id", "status", "scheduled_at_ms"] as const;
export const FUNNEL_QUERY_NAMES = ["payments", "deals", "meetings", "lifecycle"] as const;
function funnelSql(input: ReportInput<Filters>) {
  const params = rangeParams(input.range);
  return {
    payments: { sql: rangePayments, params },
    deals: { sql: `SELECT ${FUNNEL_DEAL_COLUMNS.join(", ")} FROM analytics.deals
WHERE tenant_id = {tenant_id:String}
  AND id IN (SELECT opportunity_id FROM (${rangePayments}))`, params },
    meetings: { sql: `SELECT ${FUNNEL_MEETING_COLUMNS.join(", ")} FROM analytics.meetings
WHERE tenant_id = {tenant_id:String}
  AND ((created_at_ms >= {from_ms:Int64} AND created_at_ms < {to_ms:Int64})
    OR (scheduled_at_ms >= {from_ms:Int64} AND scheduled_at_ms < {to_ms:Int64}))`, params },
    lifecycle: {
    // People are high volume. Return only stage/cohort counts to Convex.
    sql: `SELECT
  ${LIFECYCLE_STAGES.map(stage => `countIf(${entryInRange(stage)}) AS ${stage}`).join(",\n  ")},
  countIf(${entryInRange("in_conversation")}) AS entered,
  ${["qualified", "booked", "showed", "customer"].map(stage => `countIf((${entryInRange("in_conversation")}) AND ${stageTime(stage)} IS NOT NULL) AS cohort_${stage}`).join(",\n  ")}
FROM analytics.people
WHERE tenant_id = {tenant_id:String}
  AND ifNull(status, '') != 'merged' AND ifNull(merged_into_lead_id, '') = ''`, params: rangeParams(input.range),
  } };
}
function reminderSql(input: ReportInput<Filters>) {
  return { reminders: { sql: `SELECT * FROM analytics.followups
WHERE tenant_id = {tenant_id:String}
  AND type = 'manual_reminder'
  AND reminder_scheduled_at_ms >= {from_ms:Int64} AND reminder_scheduled_at_ms < {to_ms:Int64}
  ${input.filters.programId ? `AND opportunity_id IN (SELECT id FROM analytics.deals
    WHERE tenant_id = {tenant_id:String} AND first_booking_program_id = {program_id:String})` : ""}`,
    params: { ...rangeParams(input.range), ...(input.filters.programId ? { program_id: input.filters.programId } : {}) } } };
}
const bookingAnswers = (filtered: boolean) => `SELECT a.* FROM (
  SELECT * FROM analytics.form_answers WHERE tenant_id = {tenant_id:String} AND field_key = {field_key:String}
) AS a
WHERE meeting_id IN (SELECT id FROM analytics.meetings
  WHERE tenant_id = {tenant_id:String} AND created_at_ms >= {from_ms:Int64} AND created_at_ms < {to_ms:Int64}
    ${filtered ? "AND booking_program_id = {program_id:String}" : ""})
  AND lead_id IN (SELECT id FROM analytics.people
    WHERE tenant_id = {tenant_id:String} AND ifNull(status, '') != 'merged' AND ifNull(merged_into_lead_id, '') = '')`;
function answersSql(input: ReportInput<AnswerFilters>) {
  const source = bookingAnswers(!!input.filters.programId);
  const peopleDeals = `SELECT * FROM analytics.deals WHERE tenant_id = {tenant_id:String}
  AND lead_id IN (SELECT lead_id FROM (${source}))`;
  const params = { ...rangeParams(input.range), field_key: input.filters.fieldKey, ...(input.filters.programId ? { program_id: input.filters.programId } : {}) };
  return {
    // Deduplicate repeated bookings at answer/person grain before returning rows.
    responses: { sql: `SELECT min(id) AS id, lead_id, field_key, question_label_snapshot, answer_text
FROM (${source}) GROUP BY lead_id, field_key, question_label_snapshot, answer_text`, params },
    deals: { sql: peopleDeals, params },
    held: { sql: `SELECT opportunity_id FROM analytics.meetings
WHERE tenant_id = {tenant_id:String} AND status = 'held'
  AND opportunity_id IN (SELECT id FROM (${peopleDeals})) GROUP BY opportunity_id`, params },
  };
}
const liveArgs = (input: ReportInput<Filters>) => ({ range: input.range, ...(input.filters.programId ? { programId: input.filters.programId } : {}) });
const common = { page: "scorecard", roles: REPORT_ADMIN_ROLES, day: "business", parseFilters } as const;
const funnelNode: NodeBuild<Filters, FunnelOutput, Record<string, never>> = {
  context: async () => ({}),
  build: input => {
    const lifecycle = emptyLifecycle(); const row = input.rows.lifecycle?.[0] ?? {};
    for (const stage of LIFECYCLE_STAGES) lifecycle.stages[stage] = num(row[stage]);
    lifecycle.cohort.entered = num(row.entered);
    for (const stage of ["qualified", "booked", "showed", "customer"] as const) lifecycle.cohort[stage] = num(row[`cohort_${stage}`]);
    return buildFunnel(factsFromRows(input.rows), input.range, input.filters, lifecycle);
  },
};
export const scorecardReports = [
  defineReport<typeof funnel, Filters, Record<string, never>>({ ...common, id: "scorecard.funnel", sql: funnelSql,
    node: funnelNode, finalize: nodeFinalize(funnelNode), live: { name: "reports/scorecard:funnel", args: liveArgs },
  }),
  defineReport<typeof cash, Filters>({ ...common, id: "scorecard.cash", sql: factsSql,
    finalize: async (ctx, input) => {
      const facts = factsFromRows(input.rows); const names = new Map<string, string>();
      for (const id of new Set(facts.payments.map(p => p.programId))) {
        const program = await ctx.db.get("tenantPrograms", id); if (program?.tenantId === input.tenantId) names.set(id, program.name);
      }
      return buildCash(facts, input.range, input.filters, names);
    }, live: { name: "reports/scorecard:cash", args: liveArgs },
  }),
  defineReport<typeof followThrough, Filters>({ ...common, id: "scorecard.follow_through", sql: reminderSql,
    finalize: async (ctx, input) => {
      const users = await ctx.db.query("users").withIndex("by_tenantId", q => q.eq("tenantId", input.tenantId)).take(501);
      if (users.length > 500) throw new Error("Choose a shorter range");
      return buildFollowThrough(docsFromRows<"followUps">(input.rows.reminders), users, input.range, Date.now());
    }, live: { name: "reports/scorecard:followThrough", args: liveArgs },
  }),
  defineReport<typeof origins, Filters>({ ...common, id: "scorecard.origins", sql: factsSql,
    finalize: async (_ctx, input) => buildOrigins(factsFromRows(input.rows), input.range, input.filters),
    live: { name: "reports/scorecard:origins", args: liveArgs },
  }),
  defineReport<typeof answers, AnswerFilters>({ ...common, id: "scorecard.answers", sql: answersSql,
    parseFilters: async (ctx, raw) => ({ ...await parseFilters(ctx, raw), fieldKey: normalizeFieldKey(typeof raw.fieldKey === "string" ? raw.fieldKey : "") }),
    finalize: async (ctx, input) => {
      const facts: AnswerFacts = { responses: docsFromRows<"meetingFormResponses">(input.rows.responses),
        deals: docsFromRows<"opportunities">(input.rows.deals), heldDealIds: (input.rows.held ?? []).map(row => String(row.opportunity_id)), contactLabels: [] };
      return buildAnswers(facts, input.filters.fieldKey, await answerLabel(ctx, input.tenantId, input.filters.fieldKey));
    }, live: { name: "reports/scorecard:answers", args: input => ({ ...liveArgs(input), fieldKey: input.filters.fieldKey }) },
  }),
];
