import type { Id } from "../../_generated/dataModel";
import type { PublicOverviewRange } from "../../dashboard/overviewTypes";
import {
  buildMyActivitySummary,
  emptyMyActivitySummary,
  resolveOwnLeadGenWorker,
  type getMyActivitySummary,
} from "../../leadGen/activity";
import {
  buildLeadGenOverview,
  buildSourcePerformance,
  buildTeamPerformance,
  buildWorkerPerformance,
  type getOverview,
  type listSourcePerformance,
  type listTeamPerformance,
  type listWorkerPerformance,
} from "../../leadGen/reporting";
import { addBusinessDays, countBusinessDays } from "../../../lib/businessDay";
import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import type { SqlQuery } from "../clickhouse";
import { defineReport, type ReportInput } from "../definition";
import {
  dailyStatRows,
  dailyStatsSql,
  leadGenLiveArgs,
  parseLeadGenFilters,
  resparkResultCounts,
  resparkResultsSql,
  type LeadGenReportFilters,
} from "./leadGenShared";

// The Lead Gen panels the daily buckets answer, and My Activity's cards. The
// SQL rebuilds the `leadGenDailyStats` rows (leadGenShared.ts), so the
// builders run unchanged and the 500-row and 120-day caps of the Convex reads
// don't apply.

const roles = ["tenant_master", "tenant_admin"] as const;

function dailySql(input: ReportInput<LeadGenReportFilters>) {
  return { daily: dailyStatsSql(input.range, input.filters) };
}

const live = (name: string) => ({ name: `leadGen/reporting:${name}`, args: leadGenLiveArgs });

/** `toPublicOverviewRange(deriveOverviewRange(...))` for a resolved custom range. */
function publicRange(range: ResolvedAnalyticsRange): PublicOverviewRange {
  const endBusinessDateExclusive = addBusinessDays(range.endDateInclusive, 1);
  return {
    startBusinessDate: range.startDate,
    endBusinessDateInclusive: range.endDateInclusive,
    endBusinessDateExclusive,
    dayCount: countBusinessDays(range.startDate, endBusinessDateExclusive),
    label:
      range.startDate === range.endDateInclusive
        ? range.startDate
        : `${range.startDate} to ${range.endDateInclusive}`,
    operationsBoundary: "tenant_business_day",
  };
}

type MyActivityFilters = { workerId: Id<"leadGenWorkers"> | null };

export const leadGenDailyReports = [
  defineReport<typeof getOverview, LeadGenReportFilters>({
    id: "lead_gen.overview",
    page: "lead_gen",
    roles,
    day: "business",
    parseFilters: parseLeadGenFilters,
    sql: dailySql,
    finalize: async (ctx, input) =>
      await buildLeadGenOverview(ctx, input.tenantId, {
        rows: dailyStatRows(input.rows.daily),
        capped: false,
      }),
    live: live("getOverview"),
  }),
  defineReport<typeof listWorkerPerformance, LeadGenReportFilters>({
    id: "lead_gen.workers",
    page: "lead_gen",
    roles,
    day: "business",
    parseFilters: parseLeadGenFilters,
    sql: dailySql,
    finalize: async (ctx, input) =>
      await buildWorkerPerformance(ctx, input.tenantId, dailyStatRows(input.rows.daily)),
    live: live("listWorkerPerformance"),
  }),
  defineReport<typeof listTeamPerformance, LeadGenReportFilters>({
    id: "lead_gen.teams",
    page: "lead_gen",
    roles,
    day: "business",
    parseFilters: parseLeadGenFilters,
    sql: dailySql,
    finalize: async (ctx, input) =>
      await buildTeamPerformance(ctx, input.tenantId, dailyStatRows(input.rows.daily)),
    live: live("listTeamPerformance"),
  }),
  defineReport<typeof listSourcePerformance, LeadGenReportFilters>({
    id: "lead_gen.sources",
    page: "lead_gen",
    roles,
    day: "business",
    parseFilters: parseLeadGenFilters,
    sql: dailySql,
    finalize: async (ctx, input) =>
      await buildSourcePerformance(
        ctx,
        input.tenantId,
        { source: input.filters.source ?? undefined },
        dailyStatRows(input.rows.daily),
      ),
    live: live("listSourcePerformance"),
  }),
  defineReport<typeof getMyActivitySummary, MyActivityFilters>({
    id: "my_activity.summary",
    page: "my_activity",
    roles: ["lead_generator", "tenant_master", "tenant_admin"],
    day: "business",
    // The caller's own worker, so each worker has their own cache key.
    parseFilters: async (ctx, _raw, viewer) => ({
      workerId: (await resolveOwnLeadGenWorker(ctx, viewer))?.workerId ?? null,
    }),
    sql: (input): Record<string, SqlQuery> => {
      const { workerId } = input.filters;
      if (!workerId) return {};
      return {
        daily: dailyStatsSql(input.range, { workerId }),
        resparks: resparkResultsSql(input.range, workerId),
      };
    },
    finalize: async (ctx, input) => {
      const range = publicRange(input.range);
      const { workerId } = input.filters;
      if (!workerId) return emptyMyActivitySummary(range);
      return await buildMyActivitySummary(ctx, input.tenantId, {
        range,
        rows: dailyStatRows(input.rows.daily),
        resparkCounts: resparkResultCounts(input.rows.resparks).get(workerId) ?? {
          resparks: 0,
          notAFit: 0,
        },
      });
    },
    live: {
      name: "leadGen/activity:getMyActivitySummary",
      args: (input) => ({
        range: {
          kind: "custom",
          startBusinessDate: input.range.startDate,
          endBusinessDateInclusive: input.range.endDateInclusive,
        },
      }),
    },
  }),
];
