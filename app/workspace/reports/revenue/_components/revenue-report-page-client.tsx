"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { startOfMonth, endOfMonth } from "date-fns";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  ReportDateControls,
  type DateRange,
  type Granularity,
} from "../../_components/report-date-controls";
import { ReportProgramFilter } from "../../_components/report-program-filter";
import {
  ReportPaymentTypeFilter,
  type PaymentType,
} from "../../_components/report-payment-type-filter";
import {
  ReportRevenueSliceFilter,
  type RevenueSlice,
} from "../../_components/report-revenue-slice-filter";
import { RevenueReportSkeleton } from "./revenue-report-skeleton";
import { RevenueByOriginChart } from "./revenue-by-origin-chart";
import { RevenueTrendChart } from "./revenue-trend-chart";
import { CloserRevenueTable } from "./closer-revenue-table";
import { DealSizeDistribution } from "./deal-size-distribution";
import { TopDealsTable } from "./top-deals-table";
import { RevenueKpiCards } from "./revenue-kpi-cards";
import { RevenueByProgramSection } from "./revenue-by-program-section";
import { RevenueByPaymentTypeSection } from "./revenue-by-payment-type-section";
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
  const [programId, setProgramId] = useState<Id<"tenantPrograms"> | undefined>();
  const [paymentType, setPaymentType] = useState<PaymentType | undefined>();
  const [revenueSlice, setRevenueSlice] = useState<RevenueSlice | undefined>();

  const queryFilters = {
    ...dateRange,
    ...(programId ? { programId } : {}),
    ...(paymentType ? { paymentType } : {}),
    ...(revenueSlice ? { revenueSlice } : {}),
  };

  const metrics = useQuery(
    api.reporting.revenue.getRevenueMetrics,
    queryFilters,
  );
  const details = useQuery(
    api.reporting.revenue.getRevenueDetails,
    queryFilters,
  );
  const trend = useQuery(api.reporting.revenueTrend.getRevenueTrend, {
    ...queryFilters,
    granularity,
  });

  const allLoading =
    metrics === undefined && details === undefined && trend === undefined;

  if (allLoading) {
    return <RevenueReportSkeleton />;
  }

  const commissionableByCloser =
    metrics?.commissionable.byCloser.map((closer) => ({
      ...closer,
      revenuePercent:
        metrics.commissionable.finalRevenueMinor > 0
          ? (closer.revenueMinor / metrics.commissionable.finalRevenueMinor) *
            100
          : 0,
    })) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Revenue</h1>
        <p className="text-sm text-muted-foreground">
          Commissionable vs post-conversion revenue with program and payment
          type breakdowns
        </p>
      </div>

      <ReportDateControls
        value={dateRange}
        onChange={setDateRange}
        showGranularity
        granularity={granularity}
        onGranularityChange={setGranularity}
      />

      <div className="flex flex-wrap items-center gap-3">
        <ReportProgramFilter value={programId} onChange={setProgramId} />
        <ReportPaymentTypeFilter
          value={paymentType}
          onChange={setPaymentType}
        />
        <ReportRevenueSliceFilter
          value={revenueSlice}
          onChange={setRevenueSlice}
        />
      </div>

      <RevenueKpiCards metrics={metrics} />

      {trend !== undefined ? (
        <RevenueTrendChart data={trend.trend} />
      ) : (
        <Skeleton className="h-[300px] rounded-lg" />
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,1fr)]">
        {metrics !== undefined ? (
          <RevenueByOriginChart byOrigin={metrics.commissionable.byOrigin} />
        ) : (
          <Skeleton className="h-[260px] rounded-lg" />
        )}

        {metrics !== undefined ? (
          <CloserRevenueTable
            byCloser={commissionableByCloser}
            totalRevenueMinor={metrics.commissionable.finalRevenueMinor}
            totalDeals={metrics.commissionable.totalDeals}
            avgDealMinor={metrics.commissionable.avgDealMinor}
          />
        ) : (
          <Skeleton className="h-64 rounded-lg" />
        )}
      </div>

      {metrics !== undefined ? (
        <RevenueByProgramSection
          commissionable={metrics.commissionable.byProgram}
          nonCommissionable={metrics.nonCommissionable.byProgram}
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Skeleton className="h-64 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
      )}

      {metrics !== undefined ? (
        <RevenueByPaymentTypeSection byPaymentType={metrics.byPaymentType} />
      ) : (
        <Skeleton className="h-48 rounded-lg" />
      )}

      {details !== undefined ? (
        <DealSizeDistribution distribution={details.dealSizeDistribution} />
      ) : (
        <Skeleton className="h-64 rounded-lg" />
      )}

      {details !== undefined ? (
        <TopDealsTable deals={details.topDeals} />
      ) : (
        <Skeleton className="h-48 rounded-lg" />
      )}
    </div>
  );
}
