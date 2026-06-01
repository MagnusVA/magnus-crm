import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { TOP_OVERVIEW_WORKER_LIMIT } from "../leadGen/reportLimits";
import { readLeadGenDailyRowsForDashboard } from "../leadGen/reportReaders";
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
  const totalSubmissions = rows.reduce((sum, row) => sum + row.submissions, 0);
  const efficiencyRows = await buildLeadGenEfficiencyRows(ctx, {
    tenantId,
    range,
    includeAllCandidates: false,
  });

  return {
    data: {
      totalSubmissions,
      topWorkers: efficiencyRows.slice(0, TOP_OVERVIEW_WORKER_LIMIT),
    },
    isEmpty: totalSubmissions === 0 && efficiencyRows.length === 0,
  };
}
