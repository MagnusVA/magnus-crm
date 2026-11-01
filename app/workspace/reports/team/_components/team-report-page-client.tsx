"use client";
import { addBusinessDays, businessDateForInstant, businessDayStart } from "@/lib/businessDay";
import { reportRangeDayKeys } from "@/lib/reportDateRange";
import { useBusinessDay } from "@/hooks/use-business-day";
import { BusinessDayRebuildingState } from "@/app/workspace/_components/day-definition";

import { ResultsRecorded, SHOW_RATE_HELP } from "@/app/workspace/_components/results-recorded";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangleIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { addDays, startOfDay } from "date-fns";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { mergeTeamActions, mergeTeamMetrics, mergeTeamOperations } from "@/convex/analytics/merge/team";
import { dashboardRangePlan } from "@/lib/analyticsRange";
import { AnalyticsFreshnessLine } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { Skeleton } from "@/components/ui/skeleton";
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
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import type { MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";
import { TeamKpiSummaryCards } from "./team-kpi-summary-cards";
import { CloserPerformanceTable } from "./closer-performance-table";
import { MeetingOutcomeDistributionChart } from "./meeting-outcome-distribution-chart";
import { TeamReportSkeleton } from "./team-report-skeleton";
import { formatRate } from "./team-report-formatters";

function getDefaultDateRange(): DateRange {
  const now = new Date();
  return {
    startDate: startOfDay(now).getTime(),
    endDate: startOfDay(addDays(now, 1)).getTime(),
  };
}

export function TeamReportPageClient() {
  usePageTitle("Team Performance — Reports");
  const { setting, loaded, rebuilding } = useBusinessDay();
  const { captureViewed, captureFiltersChanged } =
    useReportAnalytics("team_performance");

  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
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

  const dayKeys = reportRangeDayKeys(dateRange);
  const queryRange = !loaded || rebuilding ? "skip" : {
    startDate: businessDayStart(dayKeys.startDayKey, setting),
    endDate: businessDayStart(dayKeys.endDayKeyExclusive, setting),
  };

  // Today reads Convex live, and so does today's part of a longer range; the
  // days before today read ClickHouse once the page is switched
  // (docs/agents/reporting.md).
  const now = useNow();
  const todayBusinessDate = businessDateForInstant(now, setting);
  const todayStartDayKey = dayKeys.startDayKey > todayBusinessDate ? dayKeys.startDayKey : todayBusinessDate;
  const todayArgs = queryRange === "skip" ? "skip" : {
    startDate: businessDayStart(todayStartDayKey, setting),
    endDate: queryRange.endDate,
  };
  const plan = dashboardRangePlan(
    {
      kind: "custom",
      startBusinessDate: dayKeys.startDayKey,
      endBusinessDateInclusive: addBusinessDays(dayKeys.endDayKeyExclusive, -1),
    },
    todayBusinessDate,
  );
  const metricsReport = useAnalyticsReport({
    page: "team",
    reportId: "team.metrics",
    plan,
    live: api.reporting.teamPerformance.getTeamPerformanceMetrics,
    liveArgs: queryRange,
    todayArgs,
    merge: mergeTeamMetrics,
  });
  // A payment or a reschedule today can change the outcome of an earlier
  // call, which neither half of a split would see, so the outcome mix reads
  // the whole range from ClickHouse, as of the last sync.
  const outcomeMixReport = useAnalyticsReport({
    page: "team",
    reportId: "team.outcomes",
    plan,
    live: api.reporting.teamOutcomes.getTeamOutcomeMix,
    liveArgs: queryRange,
    todayArgs: "skip",
    merge: null,
  });
  const actionsReport = useAnalyticsReport({
    page: "team",
    reportId: "team.actions",
    plan,
    live: api.reporting.teamActions.getActionsPerCloserPerDay,
    liveArgs: queryRange,
    todayArgs,
    merge: mergeTeamActions,
  });
  const operationsReport = useAnalyticsReport({
    page: "team",
    reportId: "team.operations",
    plan,
    filters: operationsFilters,
    todayArgs: !loaded || rebuilding ? "skip" : {
      ...dayKeys,
      startDayKey: todayStartDayKey,
      ...operationsFilters,
    },
    merge: mergeTeamOperations,
    live: api.reporting.teamPerformance.getTeamOperationsDimensions,
    liveArgs: !loaded || rebuilding ? "skip" : {
      ...dayKeys,
      ...operationsFilters,
    },
  });
  const metrics = metricsReport.data;
  const outcomeMix = outcomeMixReport.data;
  const actionsPerCloser = actionsReport.data;
  const operationsDimensions = operationsReport.data;
  const freshness = [
    metricsReport.freshness,
    outcomeMixReport.freshness,
    actionsReport.freshness,
    operationsReport.freshness,
  ];

  if (rebuilding) return <BusinessDayRebuildingState />;

  // A ClickHouse range can take a while to load; keep the controls and its
  // status on screen instead of the full-page skeleton.
  if (
    (metrics === undefined ||
      outcomeMix === undefined ||
      actionsPerCloser === undefined ||
      operationsDimensions === undefined) &&
    freshness.every((item) => item.source === "live")
  ) {
    return <TeamReportSkeleton />;
  }

  const notices: Array<{
    id: string;
    title: string;
    description: string;
  }> = [];

  if (plan.kind === "split" && outcomeMixReport.source === "warehouse") {
    notices.push({
      id: "outcome-as-of-sync",
      title: "Outcome mix as of the last sync",
      description:
        "A payment or reschedule today can change an earlier call's outcome, so the outcome mix updates with each sync instead of live.",
    });
  }

  if (outcomeMix?.isTruncated) {
    notices.push({
      id: "outcome-cap",
      title: "Meeting sample capped",
      description:
        "Only showing first 2,000 meetings. Narrow the date range for full outcome reporting.",
    });
  }

  if (metrics?.isPaymentDataTruncated) {
    notices.push({
      id: "payment-cap",
      title: "Payment sample capped",
      description:
        "Revenue totals may be approximate because payment records in this range exceeded the reporting cap.",
    });
  }

  if (metrics?.isCloseRateCohortTruncated) {
    notices.push({
      id: "close-rate-cap",
      title: "Close rate unavailable",
      description:
        "This range has more held calls than the live close rate can read, so the close rates show a dash. Narrow the date range to see them.",
    });
  }

  if (actionsPerCloser?.isTruncated) {
    notices.push({
      id: "action-cap",
      title: "Action sample capped",
      description:
        "Only showing first 5,000 closer actions. Daily activity averages may be understated for very large ranges.",
    });
  }

  if (operationsDimensions?.truncated) {
    notices.push({
      id: "operations-rollup-cap",
      title: "Operations rollup sample capped",
      description:
        "This range has more than 8,192 daily rollup rows, or more than 2,000 meetings for the chosen DM team or DM closer. Narrow the date range for full operations-dimension reporting.",
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Team Performance
        </h1>
        <p className="text-sm text-muted-foreground">
          Per-closer attendance, commercial, and outcome KPIs for the selected
          reporting range.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <ReportDateControls
          dayDefinition="tenant"
          value={dateRange}
          onChange={(next) => {
            setDateRange(next);
            captureOperationsFilterChange();
          }}
        />
        <AnalyticsFreshnessLine items={freshness} />
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

      {metrics !== undefined &&
      outcomeMix !== undefined &&
      actionsPerCloser !== undefined ? (
        <TeamKpiSummaryCards
          attendanceCountsPartial={metrics.attendanceCountsPartial}
          totals={metrics.teamTotals}
          derivedOutcomes={outcomeMix.derived}
          actionsPerCloser={actionsPerCloser}
        />
      ) : (
        <Skeleton className="h-48 rounded-lg" />
      )}

      {operationsDimensions !== undefined ? (
        <PhoneCloserOperationsTable data={operationsDimensions} />
      ) : (
        <Skeleton className="h-64 rounded-lg" />
      )}

      <div className="flex flex-col gap-8">
        <section>
          <div className="mb-4 flex flex-col gap-1">
            <h2 className="text-lg font-medium">New Calls</h2>
            <p className="text-sm text-muted-foreground">
              Attendance metrics on the left, conversion metrics on the right.
            </p>
          </div>
          {metrics !== undefined ? (
            <CloserPerformanceTable
              closers={metrics.closers}
              callType="new"
              attendanceCountsPartial={metrics.attendanceCountsPartial}
              teamTotals={metrics.teamTotals}
            />
          ) : (
            <Skeleton className="h-64 rounded-lg" />
          )}
        </section>

        <section>
          <div className="mb-4 flex flex-col gap-1">
            <h2 className="text-lg font-medium">Follow-Up Calls</h2>
            <p className="text-sm text-muted-foreground">
              Same closer rollup, split out for meetings that originated from
              follow-up activity.
            </p>
          </div>
          {metrics !== undefined ? (
            <CloserPerformanceTable
              closers={metrics.closers}
              callType="follow_up"
              attendanceCountsPartial={metrics.attendanceCountsPartial}
              teamTotals={metrics.teamTotals}
            />
          ) : (
            <Skeleton className="h-64 rounded-lg" />
          )}
        </section>

        <Separator />

        <section className="flex flex-col gap-6">
          {outcomeMix !== undefined ? (
            <MeetingOutcomeDistributionChart outcomeMix={outcomeMix.displayOutcome} />
          ) : (
            <Skeleton className="h-72 rounded-lg" />
          )}
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
      closer: MemberAvatarIdentity;
      scheduled: number;
      completed: number;
      canceled: number;
      noShows: number;
      resultsRecorded: number;
      pastCalls: number;
      showRate: number | null;
      noShowRate: number | null;
    }>;
    totals: {
      scheduled: number;
      completed: number;
      canceled: number;
      noShows: number;
      resultsRecorded: number;
      pastCalls: number;
      showRate: number | null;
      noShowRate: number | null;
    };
    attendanceCountsPartial: boolean;
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
              program, DM team, and DM closer attribution. {SHOW_RATE_HELP}
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
                  <TableHead className="text-right">Held</TableHead>
                  <TableHead className="text-right">Canceled</TableHead>
                  <TableHead className="text-right">No shows</TableHead>
                  <TableHead className="text-right">Show rate</TableHead>
                  <TableHead className="text-right">No-show rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => (
                  <TableRow key={row.closerId}>
                    <TableCell>
                      <MemberIdentity identity={row.closer} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.scheduled.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.completed.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.canceled.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.noShows.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatRate(row.showRate)}
                      <ResultsRecorded {...row} attendanceCountsPartial={data.attendanceCountsPartial} />
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
                    {data.totals.canceled.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {data.totals.noShows.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatRate(data.totals.showRate)}
                    <ResultsRecorded {...data.totals} attendanceCountsPartial={data.attendanceCountsPartial} />
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
