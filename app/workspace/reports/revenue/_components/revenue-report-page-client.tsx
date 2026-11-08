"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
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
import { ReportProgramDimensionFilter } from "../../_components/report-program-dimension-filter";
import {
  ReportPaymentTypeFilter,
  type PaymentType,
} from "../../_components/report-payment-type-filter";
import {
  REPORT_PAGE,
  REPORT_PAIR,
  ReportBand,
  ReportGranularitySelect,
  type ReportGranularity,
} from "../../_components/report-ui";
import { useReportAnalytics } from "../../_components/use-report-analytics";
import { ReportRangeMessage, ReportRangePicker, useReportRange } from "../../_components/use-report-range";
import { BookedVsSoldMatrix } from "./booked-vs-sold-matrix";
import { CloserRevenueTable } from "./closer-revenue-table";
import { DealSizeDistribution } from "./deal-size-distribution";
import { RevenueByOriginCard } from "./revenue-by-origin-card";
import { RevenueByPaymentTypeSection } from "./revenue-by-payment-type-section";
import { RevenueByProgramSection } from "./revenue-by-program-section";
import { RevenueFigures } from "./revenue-figures";
import { RevenueTrendChart } from "./revenue-trend-chart";
import { TopDealsTable } from "./top-deals-table";

export function RevenueReportPageClient() {
  usePageTitle("Revenue");
  const { captureViewed, captureFiltersChanged } =
    useReportAnalytics("revenue");

  const range = useReportRange();
  const [granularity, setGranularity] = useState<ReportGranularity>("month");
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
  const { plan, todayWindow, ready } = range;
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
    liveArgs: !ready ? "skip" : { ...range.window, ...readerFilters },
    todayArgs: !ready ? "skip" : { ...todayWindow, ...readerFilters },
    merge: mergeRevenueMetrics,
  });
  const detailsReport = useAnalyticsReport({
    page: "revenue",
    reportId: "revenue.details",
    plan,
    filters,
    live: api.reporting.revenue.getRevenueDetails,
    liveArgs: !ready ? "skip" : { ...range.window, ...readerFilters },
    todayArgs: !ready ? "skip" : { ...todayWindow, ...readerFilters },
    merge: mergeRevenueDetails,
  });
  const trendReport = useAnalyticsReport({
    page: "revenue",
    reportId: "revenue.trend",
    plan,
    filters: { ...filters, granularity },
    live: api.reporting.revenueTrend.getRevenueTrend,
    liveArgs: !ready ? "skip" : { ...range.window, ...readerFilters, granularity },
    todayArgs: !ready ? "skip" : { ...todayWindow, ...readerFilters, granularity },
    merge: mergeRevenueTrend,
  });
  const bookedVsSoldReport = useAnalyticsReport({
    page: "revenue",
    reportId: "revenue.booked_vs_sold",
    plan,
    filters,
    live: api.reporting.bookedVsSold.getBookedVsSoldMatrix,
    liveArgs: !ready ? "skip" : { ...range.window, ...matrixFilters },
    todayArgs: !ready ? "skip" : { ...todayWindow, ...matrixFilters },
    merge: mergeBookedVsSold,
  });
  const phrase = range.phrase;
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
        range={range.words}
        freshness={metricsReport.data !== undefined ? freshness : null}
        dayLine={range.dayLine}
        actions={
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ReportRangePicker range={range} onChange={() => captureFilterChange()} />
            <ReportGranularitySelect value={granularity} onChange={setGranularity} />
          </div>
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
      <ReportRangeMessage range={range} />
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
