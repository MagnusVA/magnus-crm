import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { TOP_OVERVIEW_WORKER_LIMIT } from "../leadGen/reportLimits";
import { summarizeDailyRows } from "../leadGen/reportBuilders";
import { readLeadGenDailyRowsForDashboard } from "../leadGen/reportReaders";
import { loadCurrentScheduledHoursByWorkerDay } from "../leadGen/schedules";
import { buildLeadGenEfficiencyRows } from "./overviewLeaderboardBuilders";
import type { DerivedOverviewRange } from "./overviewRange";
import type { LeadGenOverview } from "./overviewTypes";

export async function getLeadGenOverviewSection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: DerivedOverviewRange,
): Promise<{ data: LeadGenOverview; isEmpty: boolean }> {
  const rows = await readLeadGenDailyRowsForDashboard(ctx, {
    tenantId,
    startDayKey: range.startBusinessDate,
    endDayKey: range.endBusinessDateInclusive,
  });
  const currentScheduledHoursByWorkerDay =
    await loadCurrentScheduledHoursByWorkerDay(ctx, { tenantId, rows });
  const summary = summarizeDailyRows(rows, currentScheduledHoursByWorkerDay);
  const efficiencyRows = await buildLeadGenEfficiencyRows(ctx, {
    tenantId,
    range,
    includeAllCandidates: false,
  });

  return {
    data: {
      totalSubmissions: summary.submissions,
      uniqueProspects: summary.uniqueProspects,
      duplicates: summary.duplicates,
      scheduledHours: summary.scheduledHours,
      leadsPerHour: summary.leadsPerHour,
      topWorkers: efficiencyRows.slice(0, TOP_OVERVIEW_WORKER_LIMIT),
    },
    isEmpty: summary.submissions === 0 && efficiencyRows.length === 0,
  };
}
