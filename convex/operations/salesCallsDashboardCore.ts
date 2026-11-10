import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import {
  deriveOverviewRange,
  type OverviewRangeInput,
} from "../dashboard/overviewRange";
import { requireReportingReady } from "./reportingReadiness";
import { readLiveQueryRows } from "../lib/liveQueryBounds";
import { getNonDisputedPaymentsInRange } from "../reporting/lib/helpers";
import {
  countCloseRateCohort,
  readCloseRateCohort,
} from "../reporting/lib/closeRateCohort";
import { buildSalesCallsDashboard } from "./salesCallsDashboard";
const MAX_OPERATIONS_STATS_ROWS = 8192;
export async function readSalesCallsDashboard(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  input: OverviewRangeInput,
) {
  await requireReportingReady(ctx, tenantId);

  const range = deriveOverviewRange(
    input,
    Date.now(),
    await getTenantBusinessDay(ctx, tenantId),
  );

  // The cohort window is the meeting buckets' window: operationsStartDate
  // and operationsEndDate are the starts of the first and the day-after-last
  // business days, the same days the buckets' dayKeys cover.
  const [statsScan, paymentScan, cohort] = await Promise.all([
    readLiveQueryRows(
      ctx.db
        .query("operationsMeetingStatsV2")
        .withIndex("by_tenantId_and_dayKey", (q) =>
          q
            .eq("tenantId", tenantId)
            .gte("dayKey", range.operationsStartDayKey)
            .lt("dayKey", range.operationsEndDayKeyExclusive),
        ),
      MAX_OPERATIONS_STATS_ROWS,
      undefined,
      4 * 1024 * 1024,
    ),
    getNonDisputedPaymentsInRange(
      ctx,
      tenantId,
      range.operationsStartDate,
      range.operationsEndDate,
    ),
    readCloseRateCohort(ctx, tenantId, {
      start: range.operationsStartDate,
      end: range.operationsEndDate,
    }),
  ]);
  return await buildSalesCallsDashboard(ctx, tenantId, range, {
    statsRows: statsScan.rows,
    statsCapped: statsScan.capped,
    paymentScan,
    closeRateCohort: countCloseRateCohort(cohort.deals),
    closeRateCohortCapped: cohort.capped,
  });
}
