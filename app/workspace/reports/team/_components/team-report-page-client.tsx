"use client";

import { useState } from "react";
import { AlertTriangleIcon } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { startOfMonth, endOfMonth } from "date-fns";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import {
  ReportDateControls,
  type DateRange,
} from "../../_components/report-date-controls";
import { TeamKpiSummaryCards } from "./team-kpi-summary-cards";
import { CloserPerformanceTable } from "./closer-performance-table";
import { MeetingOutcomeDistributionChart } from "./meeting-outcome-distribution-chart";
import { MeetingTimeSummary } from "./meeting-time-summary";
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
  const outcomeMix = useQuery(
    api.reporting.teamOutcomes.getTeamOutcomeMix,
    dateRange,
  );
  const actionsPerCloser = useQuery(
    api.reporting.teamActions.getActionsPerCloserPerDay,
    dateRange,
  );

  if (
    metrics === undefined ||
    outcomeMix === undefined ||
    actionsPerCloser === undefined
  ) {
    return <TeamReportSkeleton />;
  }

  const notices: Array<{
    id: string;
    title: string;
    description: string;
  }> = [];

  if (metrics.isMeetingTimeTruncated || outcomeMix.isTruncated) {
    notices.push({
      id: "meeting-cap",
      title: "Meeting sample capped",
      description:
        "Only showing first 2,000 meetings. Narrow the date range for full meeting-time and outcome reporting.",
    });
  }

  if (metrics.isPaymentDataTruncated) {
    notices.push({
      id: "payment-cap",
      title: "Payment sample capped",
      description:
        "Revenue totals may be approximate because payment records in this range exceeded the reporting cap.",
    });
  }

  if (actionsPerCloser.isTruncated) {
    notices.push({
      id: "action-cap",
      title: "Action sample capped",
      description:
        "Only showing first 5,000 closer actions. Daily activity averages may be understated for very large ranges.",
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Team Performance
        </h1>
        <p className="text-sm text-muted-foreground">
          Per-closer attendance, commercial, outcome, and meeting-time KPIs for
          the selected reporting range.
        </p>
      </div>

      <ReportDateControls value={dateRange} onChange={setDateRange} />

      {notices.length > 0 ? (
        <div className="flex flex-col gap-3">
          {notices.map((notice) => (
            <Alert key={notice.id}>
              <AlertTriangleIcon className="size-4" />
              <AlertTitle>{notice.title}</AlertTitle>
              <AlertDescription>{notice.description}</AlertDescription>
            </Alert>
          ))}
        </div>
      ) : null}

      <TeamKpiSummaryCards
        totals={metrics.teamTotals}
        derivedOutcomes={outcomeMix.derived}
        actionsPerCloser={actionsPerCloser}
      />

      <div className="flex flex-col gap-8">
        <section>
          <div className="mb-4 flex flex-col gap-1">
            <h2 className="text-lg font-medium">New Calls</h2>
            <p className="text-sm text-muted-foreground">
              Attendance metrics on the left, conversion metrics on the right.
            </p>
          </div>
          <CloserPerformanceTable
            closers={metrics.closers}
            callType="new"
            teamTotals={metrics.teamTotals}
          />
        </section>

        <section>
          <div className="mb-4 flex flex-col gap-1">
            <h2 className="text-lg font-medium">Follow-Up Calls</h2>
            <p className="text-sm text-muted-foreground">
              Same closer rollup, split out for meetings that originated from
              follow-up activity.
            </p>
          </div>
          <CloserPerformanceTable
            closers={metrics.closers}
            callType="follow_up"
            teamTotals={metrics.teamTotals}
          />
        </section>

        <Separator />

        <section className="flex flex-col gap-6">
          <MeetingOutcomeDistributionChart outcomeMix={outcomeMix.teamOutcome} />
          <MeetingTimeSummary meetingTime={metrics.teamMeetingTime} />
        </section>
      </div>
    </div>
  );
}
