"use client";

import { useState } from "react";
import { endOfMonth, startOfMonth } from "date-fns";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ReportDateControls,
  type DateRange,
} from "../../_components/report-date-controls";
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

export function PipelineReportPageClient() {
  usePageTitle("Pipeline Health");

  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);

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

  // Both queries still loading — show full skeleton
  if (
    distribution === undefined &&
    aging === undefined &&
    backlogAndLoss === undefined
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

          <ReportDateControls value={dateRange} onChange={setDateRange} />
        </div>

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
