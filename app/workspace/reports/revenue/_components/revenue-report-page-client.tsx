"use client";
import { DayDefinition } from "@/app/workspace/_components/day-definition";

import { useCallback, useEffect, useState } from "react";
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
import { ReportProgramDimensionFilter } from "../../_components/report-program-dimension-filter";
import {
  ReportPaymentTypeFilter,
  type PaymentType,
} from "../../_components/report-payment-type-filter";
import { useReportAnalytics } from "../../_components/use-report-analytics";
import { RevenueReportSkeleton } from "./revenue-report-skeleton";
import { RevenueByOriginChart } from "./revenue-by-origin-chart";
import { RevenueTrendChart } from "./revenue-trend-chart";
import { CloserRevenueTable } from "./closer-revenue-table";
import { DealSizeDistribution } from "./deal-size-distribution";
import { TopDealsTable } from "./top-deals-table";
import { RevenueKpiCards } from "./revenue-kpi-cards";
import { RevenueByProgramSection } from "./revenue-by-program-section";
import { RevenueByPaymentTypeSection } from "./revenue-by-payment-type-section";
import { BookedVsSoldMatrix } from "./booked-vs-sold-matrix";
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
  const { captureViewed, captureFiltersChanged } =
    useReportAnalytics("revenue");

  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [granularity, setGranularity] = useState<Granularity>("month");
  const [programId, setProgramId] = useState<Id<"tenantPrograms"> | undefined>();
  const [paymentType, setPaymentType] = useState<PaymentType | undefined>();

  useEffect(() => {
    captureViewed();
  }, [captureViewed]);

  const captureFilterChange = useCallback(
    (next?: {
      programId?: Id<"tenantPrograms">;
      paymentType?: PaymentType;
    }) => {
      const nextProgramId =
        next && "programId" in next ? next.programId : programId;
      const nextPaymentType =
        next && "paymentType" in next ? next.paymentType : paymentType;
      captureFiltersChanged({
        date_range_preset: "custom",
        has_payment_program_filter: Boolean(nextProgramId),
        has_payment_type_filter: Boolean(nextPaymentType),
      });
    },
    [captureFiltersChanged, paymentType, programId],
  );

  const queryFilters = {
    ...dateRange,
    ...(programId ? { programId } : {}),
    ...(paymentType ? { paymentType } : {}),
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
  const bookedVsSold = useQuery(
    api.reporting.bookedVsSold.getBookedVsSoldMatrix,
    {
      ...dateRange,
      ...(programId ? { paymentProgramId: programId } : {}),
      ...(paymentType ? { paymentType } : {}),
    },
  );

  const allLoading =
    metrics === undefined &&
    details === undefined &&
    trend === undefined &&
    bookedVsSold === undefined;

  if (allLoading) {
    return <RevenueReportSkeleton />;
  }

  const byCloser =
    metrics?.revenue.byCloser.map((closer) => ({
      ...closer,
      revenuePercent:
        metrics.revenue.finalRevenueMinor > 0
          ? (closer.revenueMinor / metrics.revenue.finalRevenueMinor) *
            100
          : 0,
    })) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Revenue</h1>
        <p className="text-sm text-muted-foreground">
          Revenue with payment-program and payment-type breakdowns.
        </p>
      </div>

      <ReportDateControls
        value={dateRange}
        onChange={(next) => {
          setDateRange(next);
          captureFilterChange();
        }}
        showGranularity
        granularity={granularity}
        onGranularityChange={setGranularity}
      />
          <DayDefinition />

      <div className="flex flex-wrap items-center gap-3">
        <ReportProgramDimensionFilter
          dimension="payment_program"
          value={programId}
          onChange={(next) => {
            setProgramId(next);
            captureFilterChange({ programId: next });
          }}
        />
        <ReportPaymentTypeFilter
          value={paymentType}
          onChange={(next) => {
            setPaymentType(next);
            captureFilterChange({ paymentType: next });
          }}
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
          <RevenueByOriginChart byOrigin={metrics.revenue.byOrigin} />
        ) : (
          <Skeleton className="h-[260px] rounded-lg" />
        )}

        {metrics !== undefined ? (
          <CloserRevenueTable
            byCloser={byCloser}
            totalRevenueMinor={metrics.revenue.finalRevenueMinor}
            totalDeals={metrics.revenue.totalDeals}
            avgDealMinor={metrics.revenue.avgDealMinor}
          />
        ) : (
          <Skeleton className="h-64 rounded-lg" />
        )}
      </div>

      {metrics !== undefined ? (
        <RevenueByProgramSection rows={metrics.revenue.byProgram} />
      ) : (
        <Skeleton className="h-64 rounded-lg" />
      )}

      {bookedVsSold !== undefined ? (
        <BookedVsSoldMatrix matrix={bookedVsSold} />
      ) : (
        <Skeleton className="h-72 rounded-lg" />
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
