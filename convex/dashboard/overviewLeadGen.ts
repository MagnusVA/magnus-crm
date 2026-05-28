import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  buildWorkerPerformanceRows,
  summarizeDailyRows,
} from "../leadGen/reportBuilders";
import { TOP_OVERVIEW_WORKER_LIMIT } from "../leadGen/reportLimits";
import {
  loadLeadGenTeamsForRows,
  loadLeadGenWorkersForRows,
  readLeadGenDailyRowsForDashboard,
} from "../leadGen/reportReaders";
import { loadCurrentScheduledHoursByWorkerDay } from "../leadGen/schedules";
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
  const workers = await loadLeadGenWorkersForRows(ctx, tenantId, rows);
  const teams = await loadLeadGenTeamsForRows(ctx, tenantId, rows);
  const summary = summarizeDailyRows(rows, currentScheduledHoursByWorkerDay);
  const topWorkers = buildWorkerPerformanceRows({
    rows,
    currentScheduledHoursByWorkerDay,
    workers,
    teams,
  })
    .slice(0, TOP_OVERVIEW_WORKER_LIMIT)
    .map((worker) => ({
      workerId: worker.workerId,
      displayName: worker.displayName,
      submissions: worker.submissions,
      uniqueProspects: worker.uniqueProspects,
      leadsPerHour: worker.leadsPerHour,
    }));

  return {
    data: {
      totalSubmissions: summary.submissions,
      uniqueProspects: summary.uniqueProspects,
      duplicates: summary.duplicates,
      scheduledHours: summary.scheduledHours,
      leadsPerHour: summary.leadsPerHour,
      topWorkers,
    },
    isEmpty: summary.submissions === 0,
  };
}
