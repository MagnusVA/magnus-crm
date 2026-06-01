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
import { leadGenWorkerMemberIdentity } from "../lib/memberIdentity";

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
  const topWorkerRows = buildWorkerPerformanceRows({
    rows,
    currentScheduledHoursByWorkerDay,
    workers,
    teams,
  })
    .slice(0, TOP_OVERVIEW_WORKER_LIMIT)
    .map(async (worker) => ({
      workerId: worker.workerId,
      worker: await leadGenWorkerMemberIdentity(
        ctx,
        workers.get(worker.workerId),
      ),
      displayName: worker.displayName,
      submissions: worker.submissions,
      leadsPerHour: worker.leadsPerHour,
    }));
  const topWorkers = await Promise.all(topWorkerRows);

  return {
    data: {
      totalSubmissions: summary.submissions,
      duplicates: summary.duplicates,
      scheduledHours: summary.scheduledHours,
      leadsPerHour: summary.leadsPerHour,
      topWorkers,
    },
    isEmpty: summary.submissions === 0,
  };
}
