"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { startOfMonth, endOfMonth } from "date-fns";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  ReportDateControls,
  type DateRange,
} from "../../_components/report-date-controls";
import { TeamKpiSummaryCards } from "./team-kpi-summary-cards";
import { CloserPerformanceTable } from "./closer-performance-table";
import { TeamReportSkeleton } from "./team-report-skeleton";

export function TeamReportPageClient() {
  usePageTitle("Team Performance — Reports");

  const now = new Date();
  const [dateRange, setDateRange] = useState<DateRange>({
    startDate: startOfMonth(now).getTime(),
    endDate: endOfMonth(now).getTime(),
  });

  const metrics = useQuery(
    api.reporting.teamPerformance.getTeamPerformanceMetrics,
    dateRange,
  );

  if (metrics === undefined) return <TeamReportSkeleton />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Team Performance
        </h1>
        <p className="text-sm text-muted-foreground">
          Per-closer KPIs split by new and follow-up calls
        </p>
      </div>

      <ReportDateControls value={dateRange} onChange={setDateRange} />

      <TeamKpiSummaryCards totals={metrics.teamTotals} />

      <div className="space-y-8">
        <section>
          <h2 className="mb-4 text-lg font-medium">New Calls</h2>
          <CloserPerformanceTable
            closers={metrics.closers}
            callType="new"
            teamTotals={metrics.teamTotals}
          />
        </section>

        <section>
          <h2 className="mb-4 text-lg font-medium">Follow-Up Calls</h2>
          <CloserPerformanceTable
            closers={metrics.closers}
            callType="follow_up"
            teamTotals={metrics.teamTotals}
          />
        </section>
      </div>

      {metrics.isPaymentDataTruncated && (
        <p className="text-sm text-muted-foreground">
          Note: Payment data has been capped for performance. Totals may be
          approximate.
        </p>
      )}
    </div>
  );
}
