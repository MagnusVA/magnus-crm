"use client";

import { useCallback, useEffect, useState } from "react";
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
import {
  ReportAttributionFilters,
  type ReportAttributionFilterValue,
} from "../../_components/report-attribution-filters";
import { useReportAnalytics } from "../../_components/use-report-analytics";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TeamKpiSummaryCards } from "./team-kpi-summary-cards";
import { CloserPerformanceTable } from "./closer-performance-table";
import { MeetingOutcomeDistributionChart } from "./meeting-outcome-distribution-chart";
import { MeetingTimeSummary } from "./meeting-time-summary";
import { TeamReportSkeleton } from "./team-report-skeleton";
import { formatRate } from "./team-report-formatters";

export function TeamReportPageClient() {
  usePageTitle("Team Performance — Reports");
  const { captureViewed, captureFiltersChanged } =
    useReportAnalytics("team_performance");

  const now = new Date();
  const [dateRange, setDateRange] = useState<DateRange>({
    startDate: startOfMonth(now).getTime(),
    endDate: endOfMonth(now).getTime(),
  });
  const [operationsFilters, setOperationsFilters] =
    useState<ReportAttributionFilterValue>({});

  useEffect(() => {
    captureViewed();
  }, [captureViewed]);

  const captureOperationsFilterChange = useCallback(
    (next?: ReportAttributionFilterValue) => {
      const filters = next ?? operationsFilters;
      captureFiltersChanged({
        date_range_preset: "custom",
        has_booking_program_filter: Boolean(filters.bookingProgramId),
        has_attribution_team_filter: Boolean(filters.attributionTeamId),
        has_dm_closer_filter: Boolean(filters.dmCloserId),
      });
    },
    [captureFiltersChanged, operationsFilters],
  );

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
  const operationsDimensions = useQuery(
    api.reporting.teamPerformance.getTeamOperationsDimensions,
    {
      ...dateRange,
      ...operationsFilters,
    },
  );

  if (
    metrics === undefined ||
    outcomeMix === undefined ||
    actionsPerCloser === undefined ||
    operationsDimensions === undefined
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

  if (operationsDimensions.truncated) {
    notices.push({
      id: "operations-rollup-cap",
      title: "Operations rollup sample capped",
      description:
        "Booked-program and DM attribution filters are capped at 1,000 daily rollup rows. Narrow the date range for full operations-dimension reporting.",
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

      <div className="flex flex-col gap-3">
        <ReportDateControls
          value={dateRange}
          onChange={(next) => {
            setDateRange(next);
            captureOperationsFilterChange();
          }}
        />
        <ReportAttributionFilters
          value={operationsFilters}
          onChange={(next) => {
            setOperationsFilters(next);
            captureOperationsFilterChange(next);
          }}
        />
      </div>

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

      <PhoneCloserOperationsTable data={operationsDimensions} />

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

function PhoneCloserOperationsTable({
  data,
}: {
  data: {
    rows: Array<{
      closerId: string;
      closerName: string;
      scheduled: number;
      completed: number;
      noShows: number;
      reviewRequired: number;
      showRate: number | null;
      noShowRate: number | null;
    }>;
    totals: {
      scheduled: number;
      completed: number;
      noShows: number;
      reviewRequired: number;
      showRate: number | null;
      noShowRate: number | null;
    };
    truncated: boolean;
  };
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Phone Closer Operations</CardTitle>
            <CardDescription>
              Booked-call outcomes by phone closer, filterable by booked
              program, DM team, and DM closer attribution.
            </CardDescription>
          </div>
          {data.truncated ? (
            <Badge variant="destructive">Rollup sample capped</Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {data.rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No booked-call operations rows for this range.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table className="min-w-[48rem]">
              <TableHeader>
                <TableRow>
                  <TableHead>Phone closer</TableHead>
                  <TableHead className="text-right">Booked calls</TableHead>
                  <TableHead className="text-right">Completed</TableHead>
                  <TableHead className="text-right">No shows</TableHead>
                  <TableHead className="text-right">Review req.</TableHead>
                  <TableHead className="text-right">Show rate</TableHead>
                  <TableHead className="text-right">No-show rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => (
                  <TableRow key={row.closerId}>
                    <TableCell className="font-medium">
                      {row.closerName}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.scheduled.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.completed.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.noShows.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.reviewRequired.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatRate(row.showRate)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatRate(row.noShowRate)}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell className="font-semibold">Total</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {data.totals.scheduled.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {data.totals.completed.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {data.totals.noShows.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {data.totals.reviewRequired.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatRate(data.totals.showRate)}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatRate(data.totals.noShowRate)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
