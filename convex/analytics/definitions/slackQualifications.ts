import { addBusinessDays } from "../../../lib/businessDay";
import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import type { QualificationEventSummary } from "../../reporting/lib/slackQualificationLedger";
import {
  buildQualificationReport,
  qualificationReportPeriods,
  type getQualificationReport,
  type QualificationReportArgs,
  type SetterQualificationSummary,
} from "../../reporting/slackQualifications";
import type { SqlRow } from "../clickhouse";
import {
  defineReport,
  num,
  optionalEnumFilter,
  rangeParams,
  type AnalyticsFilters,
  type ReportInput,
} from "../definition";

// Slack Qualifications (app/workspace/reports/slack-qualifications). The page
// runs on the tenant's business day. A range holds about 60 events a day, too
// many to return over two years, and the unique-deal counts can't be summed
// across days, so SQL summarizes the events for the whole range, for each of
// the report's periods and for each setter, the way
// summarizeQualificationEvents does. The goal is a mutation and stays put.

type QualificationFilters = {
  granularity: "day" | "week" | "month";
  slackUserId: string | null;
};

const MAX_SLACK_USER_ID_LENGTH = 64;

async function parseQualificationFilters(_ctx: unknown, raw: AnalyticsFilters): Promise<QualificationFilters> {
  const slackUserId = typeof raw.slackUserId === "string" ? raw.slackUserId.trim() : raw.slackUserId;
  if (slackUserId !== undefined && slackUserId !== null && slackUserId !== "" &&
    (typeof slackUserId !== "string" || slackUserId.length > MAX_SLACK_USER_ID_LENGTH)) {
    throw new Error("Invalid filter.");
  }
  return {
    granularity: optionalEnumFilter(raw.granularity, ["day", "week", "month"] as const) ?? "day",
    slackUserId: typeof slackUserId === "string" && slackUserId !== "" ? slackUserId : null,
  };
}

function readerArgs(input: { range: ResolvedAnalyticsRange; filters: QualificationFilters }): QualificationReportArgs {
  return {
    startBusinessDate: input.range.startDate,
    endBusinessDateExclusive: addBusinessDays(input.range.endDateInclusive, 1),
    granularity: input.filters.granularity,
    ...(input.filters.slackUserId ? { slackUserId: input.filters.slackUserId } : {}),
  };
}

function periodsOf(input: { range: ResolvedAnalyticsRange; filters: QualificationFilters }) {
  return qualificationReportPeriods(readerArgs(input), {
    timeZone: input.range.timeZone,
    dayStartHour: input.range.dayStartHour,
  });
}

const SUMMARY_COLUMNS = `
  count() AS qualification_event_count,
  uniqExactIf(opportunity_id, linked) AS unique_linked_opportunity_count,
  uniqExactIf(opportunity_id, slack_deal) AS unique_slack_opportunity_count,
  countIf(result_kind = 'created_opportunity') AS created_opportunity_events,
  countIf(result_kind = 'duplicate_pending') AS duplicate_pending_events,
  countIf(result_kind = 'already_booked') AS already_booked_events,
  countIf(result_kind = 'unlinked') AS unlinked_events`;

function qualificationSql(input: ReportInput<QualificationFilters>) {
  const { slackUserId } = input.filters;
  const setterFilter = slackUserId !== null ? "AND slack_user_id = {slack_user_id:String}" : "";
  // A linked event counts its deal once; a deal is Slack-sourced when it was
  // created from a Slack qualification.
  const events = `
WITH events AS (
  SELECT
    slack_user_id,
    opportunity_id,
    result_kind,
    submitted_at_ms,
    ifNull(opportunity_id, '') != '' AS linked,
    linked AND opportunity_id IN (
      SELECT id
      FROM analytics.deals
      WHERE tenant_id = {tenant_id:String}
        AND source = 'slack_qualified'
    ) AS slack_deal
  FROM analytics.qualifications
  WHERE tenant_id = {tenant_id:String}
    AND submitted_at_ms >= {from_ms:Int64}
    AND submitted_at_ms < {to_ms:Int64}
    ${setterFilter}
)`;
  const params = {
    ...rangeParams(input.range),
    ...(slackUserId !== null ? { slack_user_id: slackUserId } : {}),
  };
  return {
    totals: { sql: `${events}\nSELECT ${SUMMARY_COLUMNS}\nFROM events`, params },
    periods: {
      sql: `${events}
SELECT arrayLastIndex(start -> start <= submitted_at_ms, {period_starts:Array(Int64)}) AS period_index, ${SUMMARY_COLUMNS}
FROM events
GROUP BY period_index`,
      params: { ...params, period_starts: periodsOf(input).map((period) => period.start) },
    },
    setters: {
      sql: `${events}
SELECT slack_user_id, max(submitted_at_ms) AS last_qualified_at_ms, ${SUMMARY_COLUMNS}
FROM events
GROUP BY slack_user_id`,
      params,
    },
    // The slackQualificationsByTime and slackQualificationsByUser aggregates:
    // Slack-sourced deals with a qualifier, by its submission time.
    legacy: {
      sql: `
SELECT count() AS count
FROM analytics.deals
WHERE tenant_id = {tenant_id:String}
  AND source = 'slack_qualified'
  AND JSONHas(ifNull(qualified_by_json, '{}'), 'submittedAt')
  AND JSONExtractFloat(qualified_by_json, 'submittedAt') >= {from_ms:Int64}
  AND JSONExtractFloat(qualified_by_json, 'submittedAt') < {to_ms:Int64}
  ${slackUserId !== null ? "AND JSONExtractString(qualified_by_json, 'slackUserId') = {slack_user_id:String}" : ""}`,
      params,
    },
  };
}

function summaryOf(row: SqlRow | undefined): QualificationEventSummary {
  return {
    qualificationEventCount: num(row?.qualification_event_count),
    uniqueLinkedOpportunityCount: num(row?.unique_linked_opportunity_count),
    uniqueSlackOpportunityCount: num(row?.unique_slack_opportunity_count),
    createdOpportunityEvents: num(row?.created_opportunity_events),
    duplicatePendingEvents: num(row?.duplicate_pending_events),
    alreadyBookedEvents: num(row?.already_booked_events),
    unlinkedEvents: num(row?.unlinked_events),
  };
}

export const slackQualificationReports = [
  defineReport<typeof getQualificationReport, QualificationFilters>({
    id: "slack_qualifications.report",
    page: "slack_qualifications",
    roles: ["tenant_master", "tenant_admin"],
    // The reader takes business dates in the tenant's business day.
    day: "business",
    parseFilters: parseQualificationFilters,
    sql: qualificationSql,
    finalize: async (ctx, input) => {
      const periods = periodsOf(input);
      const byPeriodStart = new Map<number, QualificationEventSummary>();
      for (const row of input.rows.periods ?? []) {
        const period = periods[num(row.period_index) - 1];
        if (period) byPeriodStart.set(period.start, summaryOf(row));
      }
      const bySlackUserId = new Map<string, SetterQualificationSummary>(
        (input.rows.setters ?? []).map((row) => [
          String(row.slack_user_id),
          { ...summaryOf(row), lastQualifiedAt: num(row.last_qualified_at_ms) },
        ]),
      );
      return await buildQualificationReport(
        ctx,
        input.tenantId,
        readerArgs(input),
        { timeZone: input.range.timeZone, dayStartHour: input.range.dayStartHour },
        {
        summary: summaryOf(input.rows.totals?.[0]),
        byPeriodStart,
        bySlackUserId,
        eventsTruncated: false,
        legacyOpportunityAggregateCount: num(input.rows.legacy?.[0]?.count),
      });
    },
    live: {
      name: "reporting/slackQualifications:getQualificationReport",
      args: (input) => readerArgs(input),
    },
  }),
];
