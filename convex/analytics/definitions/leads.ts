import type { Id } from "../../_generated/dataModel";
import {
  buildAnswerDistribution,
  buildFormResponseKpis,
  type FieldAnswerCounts,
  type getAnswerDistribution,
  type getFormResponseKpis,
} from "../../reporting/formResponseAnalytics";
import {
  buildLeadConversionMetrics,
  type getLeadConversionMetrics,
  type LeadConversionFacts,
} from "../../reporting/leadConversion";
import type { SqlRow } from "../clickhouse";
import {
  defineReport,
  noFilters,
  num,
  rangeParams,
  str,
  type AnalyticsFilters,
  type ReportInput,
} from "../definition";

// Leads & Conversions (app/workspace/reports/leads). The conversions are few
// (a few a day), so ClickHouse returns one row per conversion with the facts
// the builder reads about its deal and person. Form responses are many, so
// they are counted in SQL. The field catalog has no range and stays on Convex.

const roles = ["tenant_master", "tenant_admin"] as const;

// ── Conversions ─────────────────────────────────────────────────────────

// The meetings counted on one winning deal, as the reader caps them.
const MAX_MEETINGS_PER_WINNER = 200;

/**
 * New leads count the people who first reached Qualified in the range, as the
 * leadStageEntries aggregate does: its key is the person's
 * `lifecycleStageEnteredAt.qualified`, and a merged person has no entries.
 * Conversions are the range's first enrollments (listFirstEnrollmentsInRange),
 * each with its first payment's recorder (enrollmentFirstPayment), its deal's
 * closer, its person's first-seen time and its deal's meetings.
 */
function conversionSql(input: ReportInput<Record<string, never>>) {
  const params = rangeParams(input.range);
  return {
    new_leads: {
      sql: `
SELECT count() AS count
FROM analytics.people
WHERE tenant_id = {tenant_id:String}
  AND ifNull(status, '') != 'merged'
  AND JSONExtract(ifNull(lifecycle_stage_entered_at_json, '{}'), 'qualified', 'Nullable(Float64)') >= {from_ms:Int64}
  AND JSONExtract(ifNull(lifecycle_stage_entered_at_json, '{}'), 'qualified', 'Nullable(Float64)') < {to_ms:Int64}`,
      params,
    },
    conversions: {
      sql: `
WITH first_enrollments AS (
  SELECT e.id AS id, e.lead_id AS lead_id, e.opportunity_id AS opportunity_id,
    e.program_id AS program_id, e.enrolled_at_ms AS enrolled_at_ms, e.creation_time_ms AS creation_time_ms
  FROM analytics.enrollments AS e
  WHERE e.tenant_id = {tenant_id:String}
    AND e.enrolled_at_ms >= {from_ms:Int64}
    AND e.enrolled_at_ms < {to_ms:Int64}
    AND e.id IN (
      SELECT argMin(id, (enrolled_at_ms, creation_time_ms))
      FROM analytics.enrollments
      WHERE tenant_id = {tenant_id:String}
      GROUP BY lead_id
    )
)
SELECT
  f.lead_id AS lead_id,
  f.enrolled_at_ms AS converted_at_ms,
  f.opportunity_id AS winning_opportunity_id,
  p.recorded_by_user_id AS converted_by_user_id,
  d.found AS deal_found,
  d.assigned_closer_id AS deal_closer_id,
  l.found AS lead_found,
  l.first_seen_at_ms AS lead_first_seen_at_ms,
  mc.meeting_count AS meeting_count
FROM first_enrollments AS f
LEFT JOIN (
  SELECT opportunity_id, program_id, recorded_at_ms,
    argMin(recorded_by_user_id, creation_time_ms) AS recorded_by_user_id
  FROM analytics.payments
  WHERE tenant_id = {tenant_id:String}
    AND recorded_at_ms >= {from_ms:Int64}
    AND recorded_at_ms < {to_ms:Int64}
    AND ifNull(status, '') != 'disputed'
  GROUP BY opportunity_id, program_id, recorded_at_ms
) AS p ON p.opportunity_id = f.opportunity_id AND p.program_id = f.program_id AND p.recorded_at_ms = f.enrolled_at_ms
LEFT JOIN (
  SELECT id, assigned_closer_id, toUInt8(1) AS found
  FROM analytics.deals
  WHERE tenant_id = {tenant_id:String}
    AND id IN (SELECT opportunity_id FROM first_enrollments)
) AS d ON d.id = f.opportunity_id
LEFT JOIN (
  SELECT id, first_seen_at_ms, toUInt8(1) AS found
  FROM analytics.people
  WHERE tenant_id = {tenant_id:String}
    AND id IN (SELECT lead_id FROM first_enrollments)
) AS l ON l.id = f.lead_id
LEFT JOIN (
  SELECT opportunity_id, least(count(), ${MAX_MEETINGS_PER_WINNER}) AS meeting_count
  FROM analytics.meetings
  WHERE tenant_id = {tenant_id:String}
    AND opportunity_id IN (SELECT opportunity_id FROM first_enrollments)
  GROUP BY opportunity_id
) AS mc ON mc.opportunity_id = f.opportunity_id
ORDER BY f.enrolled_at_ms, f.creation_time_ms`,
      params,
    },
  };
}

function conversionsFromRows(rows: SqlRow[] | undefined) {
  const facts: LeadConversionFacts = {
    closerByOpportunity: new Map(),
    firstSeenAtByLead: new Map(),
    meetingsPerOpportunity: new Map(),
  };
  const conversions = (rows ?? []).map((row) => {
    const leadId = String(row.lead_id) as Id<"leads">;
    const winningOpportunityId = String(row.winning_opportunity_id) as Id<"opportunities">;
    if (num(row.deal_found) === 1) {
      facts.closerByOpportunity.set(
        winningOpportunityId,
        (str(row.deal_closer_id) ?? undefined) as Id<"users"> | undefined,
      );
    }
    if (num(row.lead_found) === 1) {
      facts.firstSeenAtByLead.set(leadId, num(row.lead_first_seen_at_ms));
    }
    facts.meetingsPerOpportunity.set(winningOpportunityId, num(row.meeting_count));
    return {
      leadId,
      convertedAt: num(row.converted_at_ms),
      winningOpportunityId,
      convertedByUserId: (str(row.converted_by_user_id) ?? undefined) as Id<"users"> | undefined,
    };
  });
  return { list: { conversions, isTruncated: false }, facts };
}

// ── Form responses ──────────────────────────────────────────────────────

// JavaScript's String.prototype.trim, in RE2: \s is [\t\n\f\r ], plus the
// vertical tab and the Unicode spaces and line separators JS also trims.
const JS_SPACE = String.raw`\\s\\x{0B}\\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}`;
const TRIMMED_ANSWER = `replaceRegexpAll(answer_text, '^[${JS_SPACE}]+|[${JS_SPACE}]+$', '')`;

const RANGE_MEETINGS = `
SELECT id
FROM analytics.meetings
WHERE tenant_id = {tenant_id:String}
  AND scheduled_at_ms >= {from_ms:Int64}
  AND scheduled_at_ms < {to_ms:Int64}`;

// Answers tied for a field's top that one answer returns. A free-text field
// (a phone, a handle) ties every answer at one response; the builder breaks
// ties by localeCompare, so the first answers in ICU order are enough.
const MAX_TIED_TOP_ANSWERS = 20;

/**
 * The range's meetings, those with any response, and each field's total
 * answers with the answers tied for its top: a free-text field has about one
 * distinct answer per response, too many to return.
 */
function formKpiSql(input: ReportInput<Record<string, never>>) {
  const params = rangeParams(input.range);
  return {
    meetings: {
      sql: `
SELECT
  (SELECT count() FROM (${RANGE_MEETINGS})) AS total_meetings,
  (
    SELECT uniqExact(meeting_id)
    FROM analytics.form_answers
    WHERE tenant_id = {tenant_id:String}
      AND meeting_id IN (${RANGE_MEETINGS})
  ) AS responded_meetings`,
      params,
    },
    top_answers: {
      sql: `
SELECT field_key, answer, count, total_responses
FROM (
  SELECT
    field_key,
    answer,
    count,
    total_responses,
    row_number() OVER (PARTITION BY field_key ORDER BY answer COLLATE 'en') AS tie_rank
  FROM (
  SELECT
    field_key,
    answer,
    count() AS count,
    sum(count()) OVER (PARTITION BY field_key) AS total_responses,
    max(count()) OVER (PARTITION BY field_key) AS top_count
  FROM (
    SELECT field_key, ${TRIMMED_ANSWER} AS answer
    FROM analytics.form_answers
    WHERE tenant_id = {tenant_id:String}
      AND meeting_id IN (${RANGE_MEETINGS})
  )
  WHERE answer != ''
  GROUP BY field_key, answer
  )
  WHERE count = top_count
)
WHERE tie_rank <= ${MAX_TIED_TOP_ANSWERS}`,
      params,
    },
  };
}

function fieldAnswerCounts(rows: SqlRow[] | undefined): FieldAnswerCounts[] {
  const byField = new Map<string, FieldAnswerCounts>();
  for (const row of rows ?? []) {
    const fieldKey = String(row.field_key);
    const field = byField.get(fieldKey) ?? { fieldKey, totalResponses: num(row.total_responses), answers: [] };
    field.answers.push({ answer: String(row.answer), count: num(row.count) });
    byField.set(fieldKey, field);
  }
  return [...byField.values()];
}

type DistributionFilters = { fieldKey: string };

const MAX_FIELD_KEY_LENGTH = 500;
// Distinct answers one distribution returns, the reader's row cap. A
// free-text field passes it over a long range; the chart has no use for the
// tail, so the answer says truncated, as the reader's does.
const MAX_DISTRIBUTION_ANSWERS = 2500;

async function parseDistributionFilters(_ctx: unknown, raw: AnalyticsFilters): Promise<DistributionFilters> {
  const fieldKey = typeof raw.fieldKey === "string" ? raw.fieldKey.trim() : "";
  if (fieldKey.length === 0 || fieldKey.length > MAX_FIELD_KEY_LENGTH) {
    throw new Error("Choose a form field.");
  }
  return { fieldKey };
}

function distributionSql(input: ReportInput<DistributionFilters>) {
  return {
    answers: {
      sql: `
SELECT ${TRIMMED_ANSWER} AS answer, count() AS count
FROM analytics.form_answers
WHERE tenant_id = {tenant_id:String}
  AND field_key = {field_key:String}
  AND captured_at_ms >= {from_ms:Int64}
  AND captured_at_ms < {to_ms:Int64}
GROUP BY answer
HAVING answer != ''
ORDER BY count DESC, min(creation_time_ms)
LIMIT ${MAX_DISTRIBUTION_ANSWERS + 1}`,
      params: { ...rangeParams(input.range), field_key: input.filters.fieldKey },
    },
  };
}

export const leadsReports = [
  defineReport<typeof getLeadConversionMetrics>({
    id: "leads.conversion_metrics",
    page: "leads",
    roles,
    day: "browser",
    parseFilters: noFilters,
    sql: conversionSql,
    finalize: async (ctx, input) =>
      await buildLeadConversionMetrics(ctx, input.tenantId, {
        newLeads: num(input.rows.new_leads?.[0]?.count),
        ...conversionsFromRows(input.rows.conversions),
      }),
    live: {
      name: "reporting/leadConversion:getLeadConversionMetrics",
      args: (input) => ({ startDate: input.range.fromMs, endDate: input.range.toMs }),
    },
  }),
  defineReport<typeof getFormResponseKpis>({
    id: "leads.form_kpis",
    page: "leads",
    roles,
    day: "browser",
    parseFilters: noFilters,
    sql: formKpiSql,
    finalize: async (_ctx, input) => {
      const meetings = input.rows.meetings?.[0];
      return buildFormResponseKpis({
        totalMeetings: num(meetings?.total_meetings),
        respondedMeetingsCount: num(meetings?.responded_meetings),
        fields: fieldAnswerCounts(input.rows.top_answers),
        isMeetingsTruncated: false,
        isFormResponsesTruncated: false,
      });
    },
    live: {
      name: "reporting/formResponseAnalytics:getFormResponseKpis",
      args: (input) => ({ startDate: input.range.fromMs, endDate: input.range.toMs }),
    },
  }),
  defineReport<typeof getAnswerDistribution, DistributionFilters>({
    id: "leads.answer_distribution",
    page: "leads",
    roles,
    day: "browser",
    parseFilters: parseDistributionFilters,
    sql: distributionSql,
    finalize: async (_ctx, input) => {
      const rows = input.rows.answers ?? [];
      return buildAnswerDistribution(
        input.filters.fieldKey,
        rows.slice(0, MAX_DISTRIBUTION_ANSWERS).map((row) => ({
          answerText: String(row.answer),
          count: num(row.count),
        })),
        rows.length > MAX_DISTRIBUTION_ANSWERS,
      );
    },
    live: {
      name: "reporting/formResponseAnalytics:getAnswerDistribution",
      args: (input) => ({
        fieldKey: input.filters.fieldKey,
        startDate: input.range.fromMs,
        endDate: input.range.toMs,
      }),
    },
  }),
];
