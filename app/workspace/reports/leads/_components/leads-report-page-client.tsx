"use client";

import { useState } from "react";
import { addDays, startOfDay } from "date-fns";
import { api } from "@/convex/_generated/api";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { reportRangeToAnalyticsRange } from "@/lib/analyticsRange";
import { AnalyticsFreshnessLine } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import {
  ReportDateControls,
  type DateRange,
} from "../../_components/report-date-controls";
import { AvgMeetingsPerSaleCard } from "./avg-meetings-per-sale-card";
import { AvgTimeToConversionCard } from "./avg-time-to-conversion-card";
import { ConversionKpiCards } from "./conversion-kpi-cards";
import { ConversionByCloserTable } from "./conversion-by-closer-table";
import { FormResponseRateCard } from "./form-response-rate-card";
import { FormResponseAnalyticsSection } from "./form-response-analytics-section";
import { LeadsReportSkeleton } from "./leads-report-skeleton";
import { TopAnswerPerFieldList } from "./top-answer-per-field-list";

function getDefaultDateRange(): DateRange {
  const now = new Date();
  return {
    startDate: startOfDay(now).getTime(),
    endDate: startOfDay(addDays(now, 1)).getTime(),
  };
}

export function LeadsReportPageClient() {
  usePageTitle("Leads & Conversions");

  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [selectedFieldKey, setSelectedFieldKey] = useState<string | null>(null);

  // Today reads Convex live; any other range reads ClickHouse once the page
  // is switched (docs/plans/clickhouse-reporting.md §4).
  const now = useNow();
  const range = reportRangeToAnalyticsRange(dateRange, now);
  const rangeArgs = {
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
  };
  const metricsReport = useAnalyticsReport({
    page: "leads",
    reportId: "leads.conversion_metrics",
    range,
    live: api.reporting.leadConversion.getLeadConversionMetrics,
    liveArgs: rangeArgs,
  });
  const formKpisReport = useAnalyticsReport({
    page: "leads",
    reportId: "leads.form_kpis",
    range,
    live: api.reporting.formResponseAnalytics.getFormResponseKpis,
    liveArgs: rangeArgs,
  });
  const distributionReport = useAnalyticsReport({
    page: "leads",
    reportId: "leads.answer_distribution",
    range,
    filters: { fieldKey: selectedFieldKey },
    live: api.reporting.formResponseAnalytics.getAnswerDistribution,
    liveArgs: selectedFieldKey
      ? { fieldKey: selectedFieldKey, ...rangeArgs }
      : "skip",
  });
  const metrics = metricsReport.data;
  const formKpis = formKpisReport.data;
  const freshness = [
    metricsReport.freshness,
    formKpisReport.freshness,
    ...(selectedFieldKey ? [distributionReport.freshness] : []),
  ];

  const isLoading = metrics === undefined || formKpis === undefined;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Leads & Conversions
        </h1>
        <p className="text-sm text-muted-foreground">
          Lead-to-customer conversion tracking and booking form insights
        </p>
      </div>

      <ReportDateControls
        value={dateRange}
        onChange={(next) => {
          setDateRange(next);
          // The form section reloaded with a new range and lost its field.
          setSelectedFieldKey(null);
        }}
      />
      <AnalyticsFreshnessLine items={freshness} />

      {isLoading ? (
        <LeadsReportSkeleton />
      ) : (
        <>
          <ConversionKpiCards
            newLeads={metrics.newLeads}
            totalConversions={metrics.totalConversions}
            conversionRate={metrics.conversionRate}
          />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <AvgMeetingsPerSaleCard
              avg={metrics.avgMeetingsPerSale}
              numerator={metrics.meetingsPerSaleNumerator}
              denominator={metrics.meetingsPerSaleDenominator}
            />
            <AvgTimeToConversionCard
              avgMs={metrics.avgTimeToConversionMs}
              sampleCount={metrics.timeToConversionSampleCount}
            />
            <FormResponseRateCard
              rate={formKpis.formResponseRate}
              numerator={formKpis.respondedMeetingsCount}
              denominator={formKpis.totalMeetings}
            />
          </div>

          <ConversionByCloserTable
            byCloser={metrics.byCloser}
            totalConversions={metrics.totalConversions}
          />

          <TopAnswerPerFieldList rows={formKpis.topAnswerPerField} />

          <FormResponseAnalyticsSection
            selectedFieldKey={selectedFieldKey}
            onSelectedFieldKeyChange={setSelectedFieldKey}
            distribution={distributionReport.data}
          />
        </>
      )}
    </div>
  );
}
