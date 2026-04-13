"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { startOfMonth, endOfMonth } from "date-fns";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  ReportDateControls,
  type DateRange,
  type Granularity,
} from "../../_components/report-date-controls";
import { RevenueReportSkeleton } from "./revenue-report-skeleton";
import { RevenueTrendChart } from "./revenue-trend-chart";
import { CloserRevenueTable } from "./closer-revenue-table";
import { DealSizeDistribution } from "./deal-size-distribution";
import { TopDealsTable } from "./top-deals-table";
import { Skeleton } from "@/components/ui/skeleton";

function getDefaultDateRange(): DateRange {
  const now = new Date();
  return {
    startDate: startOfMonth(now).getTime(),
    endDate: endOfMonth(now).getTime(),
  };
}

export function RevenueReportPageClient() {
  usePageTitle("Revenue");

  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [granularity, setGranularity] = useState<Granularity>("month");

  const metrics = useQuery(api.reporting.revenue.getRevenueMetrics, dateRange);
  const details = useQuery(api.reporting.revenue.getRevenueDetails, dateRange);
  const trend = useQuery(api.reporting.revenueTrend.getRevenueTrend, {
    ...dateRange,
    granularity,
  });

  const allLoading =
    metrics === undefined && details === undefined && trend === undefined;

  if (allLoading) {
    return <RevenueReportSkeleton />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Revenue</h1>
        <p className="text-sm text-muted-foreground">
          Revenue trends, per-closer breakdown, and deal analysis
        </p>
      </div>

      <ReportDateControls
        value={dateRange}
        onChange={setDateRange}
        showGranularity
        granularity={granularity}
        onGranularityChange={setGranularity}
      />

      {trend !== undefined ? (
        <RevenueTrendChart data={trend.trend} />
      ) : (
        <Skeleton className="h-[260px] rounded-lg" />
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {metrics !== undefined ? (
          <CloserRevenueTable
            byCloser={metrics.byCloser}
            totalRevenueMinor={metrics.totalRevenueMinor}
            totalDeals={metrics.totalDeals}
            avgDealMinor={metrics.avgDealMinor}
          />
        ) : (
          <Skeleton className="h-64 rounded-lg" />
        )}

        {details !== undefined ? (
          <DealSizeDistribution
            distribution={details.dealSizeDistribution}
          />
        ) : (
          <Skeleton className="h-64 rounded-lg" />
        )}
      </div>

      {details !== undefined ? (
        <TopDealsTable deals={details.topDeals} />
      ) : (
        <Skeleton className="h-48 rounded-lg" />
      )}
    </div>
  );
}
