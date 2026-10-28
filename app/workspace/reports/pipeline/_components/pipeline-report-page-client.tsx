"use client";
import { useBusinessDay } from "@/hooks/use-business-day";
import { reportRangeDayKeys } from "@/lib/reportDateRange";
import { BusinessDayRebuildingState } from "@/app/workspace/_components/day-definition";

import { ResultsRecorded, SHOW_RATE_HELP } from "@/app/workspace/_components/results-recorded";

import { useCallback, useEffect, useState } from "react";
import { addDays, startOfDay } from "date-fns";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useNow } from "@/hooks/use-now";
import { reportRangeToAnalyticsRange } from "@/lib/analyticsRange";
import { AnalyticsFreshnessLine } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { usePageTitle } from "@/hooks/use-page-title";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ReportDateControls,
  type DateRange,
} from "../../_components/report-date-controls";
import {
  ReportAttributionFilters,
  type ReportAttributionFilterValue,
} from "../../_components/report-attribution-filters";
import { useReportAnalytics } from "../../_components/use-report-analytics";
import { LossAttributionChart } from "./loss-attribution-chart";
import { NoShowSourceSplitChart } from "./no-show-source-split-chart";
import { StageDistributionChart } from "./stage-distribution-chart";
import { VelocityMetricCard } from "./velocity-metric-card";
import { PipelineAgingTable } from "./pipeline-aging-table";
import { StalePipelineList } from "./stale-pipeline-list";
import { PipelineReportSkeleton } from "./pipeline-report-skeleton";
import { UnresolvedRemindersCard } from "./unresolved-reminders-card";

function getTodayRange(nowMs = Date.now()): DateRange {
  const now = new Date(nowMs);
  return {
    startDate: startOfDay(now).getTime(),
    endDate: startOfDay(addDays(now, 1)).getTime(),
  };
}

export function PipelineReportPageClient() {
  usePageTitle("Pipeline Health");
  const { loaded, rebuilding } = useBusinessDay();
  const { captureViewed, captureFiltersChanged } =
    useReportAnalytics("pipeline_health");

  const [dateRange, setDateRange] = useState<DateRange>(() => getTodayRange());
  const [attributionFilters, setAttributionFilters] =
    useState<ReportAttributionFilterValue>({});

  useEffect(() => {
    captureViewed();
  }, [captureViewed]);

  const captureOperationsFilterChange = useCallback(
    (next?: ReportAttributionFilterValue) => {
      const filters = next ?? attributionFilters;
      captureFiltersChanged({
        date_range_preset: "custom",
        has_booking_program_filter: Boolean(filters.bookingProgramId),
        has_attribution_team_filter: Boolean(filters.attributionTeamId),
        has_dm_closer_filter: Boolean(filters.dmCloserId),
      });
    },
    [attributionFilters, captureFiltersChanged],
  );

  const distribution = useQuery(
    api.reporting.pipelineHealth.getPipelineDistribution,
  );
  const aging = useQuery(api.reporting.pipelineHealth.getPipelineAging);
  // Today reads Convex live; any other range reads ClickHouse once the page
  // is switched (docs/plans/clickhouse-reporting.md §4).
  const now = useNow();
  const range = reportRangeToAnalyticsRange(dateRange, now);
  const backlogAndLossReport = useAnalyticsReport({
    page: "pipeline",
    reportId: "pipeline.backlog_and_loss",
    range,
    live: api.reporting.pipelineHealth.getPipelineBacklogAndLoss,
    liveArgs: {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
    },
  });
  const operationsShowRateReport = useAnalyticsReport({
    page: "pipeline",
    reportId: "pipeline.show_rate",
    range,
    filters: {
      bookingProgramId: attributionFilters.bookingProgramId,
      attributionTeamId: attributionFilters.attributionTeamId,
      dmCloserId: attributionFilters.dmCloserId,
    },
    live: api.reporting.pipelineHealth.getSchedulingShowRateByOperationsDimensions,
    liveArgs: !loaded || rebuilding ? "skip" : {
      ...reportRangeDayKeys(dateRange),
      ...attributionFilters,
    },
  });
  const backlogAndLoss = backlogAndLossReport.data;
  const operationsShowRate = operationsShowRateReport.data;
  // The reminder backlog has no range, so it stays real time: a ClickHouse
  // range takes it from today's live read.
  const liveBacklog = useQuery(
    api.reporting.pipelineHealth.getPipelineBacklogAndLoss,
    backlogAndLossReport.source === "warehouse" ? getTodayRange(now) : "skip",
  );
  const reminderBacklog =
    backlogAndLossReport.source === "warehouse" ? liveBacklog : backlogAndLoss;
  const freshness = [
    backlogAndLossReport.freshness,
    operationsShowRateReport.freshness,
  ];

  // Both queries still loading — show full skeleton
  if (
    !rebuilding &&
    distribution === undefined &&
    aging === undefined &&
    backlogAndLoss === undefined &&
    operationsShowRate === undefined &&
    freshness.every((item) => item.source === "live")
  ) {
    return <PipelineReportSkeleton />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Pipeline Health
        </h1>
        <p className="text-sm text-muted-foreground">
          Live pipeline health plus date-scoped diagnostics for no-shows and
          loss attribution.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {distribution !== undefined ? (
          <StageDistributionChart
            distribution={distribution.distribution}
          />
        ) : (
          <Skeleton className="h-[300px] rounded-lg" />
        )}

        {aging !== undefined ? (
          <VelocityMetricCard velocityDays={aging.velocityDays} />
        ) : (
          <Skeleton className="h-28 rounded-lg" />
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {reminderBacklog !== undefined ? (
          <UnresolvedRemindersCard
            count={reminderBacklog.unresolvedRemindersCount}
            split={reminderBacklog.unresolvedReminderSplit}
            isTruncated={reminderBacklog.isUnresolvedRemindersTruncated}
          />
        ) : (
          <Skeleton className="h-28 rounded-lg" />
        )}
      </div>

      {aging !== undefined ? (
        <PipelineAgingTable agingByStage={aging.agingByStage} />
      ) : (
        <Skeleton className="h-48 rounded-lg" />
      )}

      {aging !== undefined ? (
        <StalePipelineList
          staleCount={aging.staleCount}
          staleOpps={aging.staleOpps}
        />
      ) : (
        <Skeleton className="h-48 rounded-lg" />
      )}

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold tracking-tight">
              Range Diagnostics
            </h2>
            <p className="text-sm text-muted-foreground">
              The charts below follow the selected range. The backlog card
              above stay real-time.
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
              value={attributionFilters}
              onChange={(next) => {
                setAttributionFilters(next);
                captureOperationsFilterChange(next);
              }}
            />
          </div>
        </div>

        {rebuilding ? <BusinessDayRebuildingState /> : operationsShowRate !== undefined ? (
          <SchedulingShowRateCard stats={operationsShowRate} />
        ) : (
          <Skeleton className="h-36 rounded-lg" />
        )}

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {backlogAndLoss !== undefined ? (
            <NoShowSourceSplitChart split={backlogAndLoss.noShowSourceSplit} />
          ) : (
            <Skeleton className="h-[340px] rounded-lg" />
          )}

          {backlogAndLoss !== undefined ? (
            <LossAttributionChart
              isTruncated={backlogAndLoss.isLossAttributionTruncated}
              lossAttribution={backlogAndLoss.lossAttribution}
            />
          ) : (
            <Skeleton className="h-[340px] rounded-lg" />
          )}
        </div>
      </section>
    </div>
  );
}

function SchedulingShowRateCard({
  stats,
}: {
  stats: {
    scheduled: number;
    shown: number;
    canceled: number;
    noShows: number;
    resultsRecorded: number;
    pastCalls: number;
    showRate: number | null;
    noShowRate: number | null;
    attendanceCountsPartial: boolean;
    truncated: boolean;
  };
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Scheduling Show Rate</CardTitle>
            <CardDescription>
              Booked-call metrics grouped by booked program, DM team, and DM
              closer. {SHOW_RATE_HELP}
            </CardDescription>
          </div>
          {stats.truncated ? (
            <Badge variant="destructive">Rollup sample capped</Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          <PipelineMetric label="Booked calls" value={stats.scheduled} />
          <PipelineMetric label="Shown" value={stats.shown} />
          <PipelineMetric label="Canceled" value={stats.canceled} />
          <PipelineMetric label="No shows" value={stats.noShows} />
          <div>
            <PipelineMetric
              label="Show rate"
              value={formatPercent(stats.showRate)}
            />
            <ResultsRecorded {...stats} />
          </div>
          <PipelineMetric
            label="No-show rate"
            value={formatPercent(stats.noShowRate)}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function PipelineMetric({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

function formatPercent(value: number | null): string {
  return value === null
    ? "—"
    : `${(value * 100).toLocaleString(undefined, {
        maximumFractionDigits: 1,
      })}%`;
}
