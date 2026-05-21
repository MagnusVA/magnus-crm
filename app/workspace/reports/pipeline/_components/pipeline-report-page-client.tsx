"use client";

import { useCallback, useEffect, useState } from "react";
import { endOfMonth, startOfMonth } from "date-fns";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
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
import { PendingOverranReviewsCard } from "./pending-overran-reviews-card";
import { StatusDistributionChart } from "./status-distribution-chart";
import { VelocityMetricCard } from "./velocity-metric-card";
import { PipelineAgingTable } from "./pipeline-aging-table";
import { StalePipelineList } from "./stale-pipeline-list";
import { PipelineReportSkeleton } from "./pipeline-report-skeleton";
import { UnresolvedRemindersCard } from "./unresolved-reminders-card";

function getDefaultDateRange(): DateRange {
  const now = new Date();
  return {
    startDate: startOfMonth(now).getTime(),
    endDate: endOfMonth(now).getTime(),
  };
}

function toDayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function PipelineReportPageClient() {
  usePageTitle("Pipeline Health");
  const { captureViewed, captureFiltersChanged } =
    useReportAnalytics("pipeline_health");

  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
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
  const backlogAndLoss = useQuery(
    api.reporting.pipelineHealth.getPipelineBacklogAndLoss,
    {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
    },
  );
  const operationsShowRate = useQuery(
    api.reporting.pipelineHealth.getSchedulingShowRateByOperationsDimensions,
    {
      startDayKey: toDayKey(dateRange.startDate),
      endDayKeyExclusive: toDayKey(dateRange.endDate),
      ...attributionFilters,
    },
  );

  // Both queries still loading — show full skeleton
  if (
    distribution === undefined &&
    aging === undefined &&
    backlogAndLoss === undefined &&
    operationsShowRate === undefined
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
          <StatusDistributionChart
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
        {backlogAndLoss !== undefined ? (
          <PendingOverranReviewsCard
            count={backlogAndLoss.pendingReviewsCount}
            isTruncated={backlogAndLoss.isPendingReviewsTruncated}
          />
        ) : (
          <Skeleton className="h-28 rounded-lg" />
        )}

        {backlogAndLoss !== undefined ? (
          <UnresolvedRemindersCard
            count={backlogAndLoss.unresolvedRemindersCount}
            split={backlogAndLoss.unresolvedReminderSplit}
            isTruncated={backlogAndLoss.isUnresolvedRemindersTruncated}
          />
        ) : (
          <Skeleton className="h-28 rounded-lg" />
        )}
      </div>

      {aging !== undefined ? (
        <PipelineAgingTable agingByStatus={aging.agingByStatus} />
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
              The charts below follow the selected range. The backlog cards
              above stay real-time.
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
              value={attributionFilters}
              onChange={(next) => {
                setAttributionFilters(next);
                captureOperationsFilterChange(next);
              }}
            />
          </div>
        </div>

        {operationsShowRate !== undefined ? (
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
    noShows: number;
    reviewRequired: number;
    showRate: number | null;
    noShowRate: number | null;
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
              closer.
            </CardDescription>
          </div>
          {stats.truncated ? (
            <Badge variant="destructive">Rollup sample capped</Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <PipelineMetric label="Booked calls" value={stats.scheduled} />
          <PipelineMetric label="Shown" value={stats.shown} />
          <PipelineMetric label="No shows" value={stats.noShows} />
          <PipelineMetric
            label="Show rate"
            value={formatPercent(stats.showRate)}
          />
          <PipelineMetric
            label="No-show rate"
            value={formatPercent(stats.noShowRate)}
          />
        </div>
        {stats.reviewRequired > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {stats.reviewRequired.toLocaleString()} meeting-overran rows are
            waiting for review and remain visible in booked-call totals.
          </p>
        ) : null}
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
    ? "-"
    : `${(value * 100).toLocaleString(undefined, {
        maximumFractionDigits: 1,
      })}%`;
}
