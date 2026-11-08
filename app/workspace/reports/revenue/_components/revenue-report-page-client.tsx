"use client";

import { useCallback, useEffect, useState } from "react";
import { addDays, startOfDay } from "date-fns";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { reportRangePlan, reportWindowFromToday } from "@/lib/analyticsRange";
import {
  mergeBookedVsSold,
  mergeRevenueDetails,
  mergeRevenueMetrics,
  mergeRevenueTrend,
} from "@/convex/analytics/merge/revenue";
import {
  AnalyticsFreshnessAlert,
  freshnessSummary,
} from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import {
  ReportDateControls,
  reportDayLine,
  reportRangePhrase,
  reportRangeWords,
  type DateRange,
  type Granularity,
} from "../../_components/report-date-controls";
import { ReportProgramDimensionFilter } from "../../_components/report-program-dimension-filter";
import {
  ReportPaymentTypeFilter,
  type PaymentType,
} from "../../_components/report-payment-type-filter";
import { REPORT_PAGE, REPORT_PAIR, ReportBand } from "../../_components/report-ui";
import { useReportAnalytics } from "../../_components/use-report-analytics";
import { BookedVsSoldMatrix } from "./booked-vs-sold-matrix";
import { CloserRevenueTable } from "./closer-revenue-table";
import { DealSizeDistribution } from "./deal-size-distribution";
import { RevenueByOriginCard } from "./revenue-by-origin-card";
import { RevenueByPaymentTypeSection } from "./revenue-by-payment-type-section";
import { RevenueByProgramSection } from "./revenue-by-program-section";
import { RevenueFigures } from "./revenue-figures";
import { RevenueTrendChart } from "./revenue-trend-chart";
import { TopDealsTable } from "./top-deals-table";

function getDefaultDateRange(): DateRange {
  const now = new Date();
  return {
    startDate: startOfDay(now).getTime(),
    endDate: startOfDay(addDays(now, 1)).getTime(),
  };
}

export function RevenueReportPageClient() {
  usePageTitle("Revenue");
  const { setting } = useBusinessDay();
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

  // Today reads Convex live, and so does today's part of a longer range; the
  // days before today read ClickHouse once the page is switched
  // (docs/agents/reporting.md).
  const now = useNow();
  const plan = reportRangePlan(dateRange, now);
  const todayWindow = reportWindowFromToday(dateRange, now);
  const filters = { programId, paymentType };
  const readerFilters = {
    ...(programId ? { programId } : {}),
    ...(paymentType ? { paymentType } : {}),
  };
  const matrixFilters = {
    ...(programId ? { paymentProgramId: programId } : {}),
    ...(paymentType ? { paymentType } : {}),
  };
  const metricsReport = useAnalyticsReport({
    page: "revenue",
    reportId: "revenue.metrics",
    plan,
    filters,
    live: api.reporting.revenue.getRevenueMetrics,
    liveArgs: { ...dateRange, ...readerFilters },
    todayArgs: { ...todayWindow, ...readerFilters },
    merge: mergeRevenueMetrics,
  });
  const detailsReport = useAnalyticsReport({
    page: "revenue",
    reportId: "revenue.details",
    plan,
    filters,
    live: api.reporting.revenue.getRevenueDetails,
    liveArgs: { ...dateRange, ...readerFilters },
    todayArgs: { ...todayWindow, ...readerFilters },
    merge: mergeRevenueDetails,
  });
  const trendReport = useAnalyticsReport({
    page: "revenue",
    reportId: "revenue.trend",
    plan,
    filters: { ...filters, granularity },
    live: api.reporting.revenueTrend.getRevenueTrend,
    liveArgs: { ...dateRange, ...readerFilters, granularity },
    todayArgs: { ...todayWindow, ...readerFilters, granularity },
    merge: mergeRevenueTrend,
  });
  const bookedVsSoldReport = useAnalyticsReport({
    page: "revenue",
    reportId: "revenue.booked_vs_sold",
    plan,
    filters,
    live: api.reporting.bookedVsSold.getBookedVsSoldMatrix,
    liveArgs: { ...dateRange, ...matrixFilters },
    todayArgs: { ...todayWindow, ...matrixFilters },
    merge: mergeBookedVsSold,
  });
  const phrase = reportRangePhrase(dateRange);
  // Each section keeps its last data, dimmed, while a new range or filter
  // loads (DESIGN.md, Kept Data While Reloading).
  const metrics = useKeptWhileLoading(metricsReport.data, phrase);
  const details = useKeptWhileLoading(detailsReport.data, phrase);
  const trend = useKeptWhileLoading(trendReport.data, phrase);
  const bookedVsSold = useKeptWhileLoading(bookedVsSoldReport.data, phrase);

  const freshness = freshnessSummary(
    [metricsReport.freshness, detailsReport.freshness, trendReport.freshness, bookedVsSoldReport.freshness],
    now,
  );
  const revenue = metrics.data?.revenue;

  return (
    <div className={REPORT_PAGE}>
      <ReportBand
        title="Revenue"
        range={reportRangeWords(dateRange)}
        freshness={metricsReport.data !== undefined ? freshness : null}
        dayLine={reportDayLine("browser", setting)}
        actions={
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
        }
        figures={<RevenueFigures metrics={metrics.data} rangePhrase={metrics.phrase} reloading={metrics.reloading} />}
        filters={
          <>
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
          </>
        }
      />
      <AnalyticsFreshnessAlert summary={freshness} />

      <RevenueTrendChart data={trend.data?.trend} rangePhrase={trend.phrase} reloading={trend.reloading} />

      <div className={REPORT_PAIR}>
        <CloserRevenueTable
          rows={revenue?.byCloser}
          totals={revenue}
          rangePhrase={metrics.phrase}
          reloading={metrics.reloading}
        />
        <RevenueByOriginCard
          byOrigin={revenue?.byOrigin}
          totalMinor={revenue?.finalRevenueMinor ?? 0}
          rangePhrase={metrics.phrase}
          reloading={metrics.reloading}
        />
      </div>

      <div className={REPORT_PAIR}>
        <RevenueByProgramSection rows={revenue?.byProgram} rangePhrase={metrics.phrase} reloading={metrics.reloading} />
        <RevenueByPaymentTypeSection
          byPaymentType={metrics.data?.byPaymentType}
          rangePhrase={metrics.phrase}
          reloading={metrics.reloading}
        />
      </div>

      <div className={REPORT_PAIR}>
        <BookedVsSoldMatrix matrix={bookedVsSold.data} rangePhrase={bookedVsSold.phrase} reloading={bookedVsSold.reloading} />
        <DealSizeDistribution
          distribution={details.data?.dealSizeDistribution}
          rangePhrase={details.phrase}
          reloading={details.reloading}
        />
      </div>

      <TopDealsTable deals={details.data?.topDeals} rangePhrase={details.phrase} reloading={details.reloading} />
    </div>
  );
}
