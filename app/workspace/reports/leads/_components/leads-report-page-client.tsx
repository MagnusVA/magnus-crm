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
import { ConversionKpiCards } from "./conversion-kpi-cards";
import { ConversionByCloserTable } from "./conversion-by-closer-table";
import { FormResponseAnalyticsSection } from "./form-response-analytics-section";
import { LeadsReportSkeleton } from "./leads-report-skeleton";

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

      {metrics === undefined ? (
        <LeadsReportSkeleton />
      ) : (
        <>
          <ConversionKpiCards
            newLeads={metrics.newLeads}
            totalConversions={metrics.totalConversions}
            conversionRate={metrics.conversionRate}
          />

          <ConversionByCloserTable
            byCloser={metrics.byCloser}
            totalConversions={metrics.totalConversions}
          />

          <FormResponseAnalyticsSection dateRange={dateRange} />
        </>
      )}
    </div>
  );
}
