"use client";

import { useState } from "react";
import { usePreloadedQuery, useQuery } from "convex/react";
import type { Preloaded } from "convex/react";
import { api } from "@/convex/_generated/api";
import { StatsRow } from "./stats-row";
import {
  TimePeriodFilter,
  useDateRange,
  getPeriodLabel,
  type TimePeriod,
} from "./time-period-filter";

/**
 * Client wrapper that unwraps preloaded stats and renders StatsRow.
 *
 * Manages the time-period filter state and the period-scoped query
 * so that the parent server component doesn't need client-side state.
 */
export function StatsRowClient({
  preloadedStats,
}: {
  preloadedStats: Preloaded<typeof api.dashboard.adminStats.getAdminDashboardStats>;
}) {
  const stats = usePreloadedQuery(preloadedStats);
  const [period, setPeriod] = useState<TimePeriod>("today");
  const dateRange = useDateRange(period);
  const periodLabel = getPeriodLabel(period);

  const periodStats = useQuery(
    api.dashboard.adminStats.getTimePeriodStats,
    { periodStart: dateRange.periodStart, periodEnd: dateRange.periodEnd },
  );

  if (!stats) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <TimePeriodFilter value={period} onValueChange={setPeriod} />
      </div>
      <StatsRow
        stats={stats}
        periodStats={periodStats ?? null}
        periodLabel={periodLabel}
      />
    </div>
  );
}
