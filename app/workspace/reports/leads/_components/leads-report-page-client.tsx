"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { startOfMonth, endOfMonth } from "date-fns";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
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
    startDate: startOfMonth(now).getTime(),
    endDate: endOfMonth(now).getTime(),
  };
}

export function LeadsReportPageClient() {
  usePageTitle("Leads & Conversions");

  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);

  const metrics = useQuery(
    api.reporting.leadConversion.getLeadConversionMetrics,
    {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
    },
  );
  const formKpis = useQuery(
    api.reporting.formResponseAnalytics.getFormResponseKpis,
    {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
    },
  );

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

      <ReportDateControls value={dateRange} onChange={setDateRange} />

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

          <FormResponseAnalyticsSection dateRange={dateRange} />
        </>
      )}
    </div>
  );
}
