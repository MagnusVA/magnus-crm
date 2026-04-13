"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDistributionChart } from "./status-distribution-chart";
import { VelocityMetricCard } from "./velocity-metric-card";
import { PipelineAgingTable } from "./pipeline-aging-table";
import { StalePipelineList } from "./stale-pipeline-list";
import { PipelineReportSkeleton } from "./pipeline-report-skeleton";

export function PipelineReportPageClient() {
  usePageTitle("Pipeline Health");

  const distribution = useQuery(
    api.reporting.pipelineHealth.getPipelineDistribution,
  );
  const aging = useQuery(api.reporting.pipelineHealth.getPipelineAging);

  // Both queries still loading — show full skeleton
  if (distribution === undefined && aging === undefined) {
    return <PipelineReportSkeleton />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Pipeline Health
        </h1>
        <p className="text-sm text-muted-foreground">
          Current pipeline status, aging, and velocity metrics
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

      {aging !== undefined ? (
        <PipelineAgingTable agingByStatus={aging.agingByStatus} />
      ) : (
        <Skeleton className="h-48 rounded-lg" />
      )}

      {aging !== undefined ? (
        <StalePipelineList staleOpps={aging.staleOpps} />
      ) : (
        <Skeleton className="h-48 rounded-lg" />
      )}
    </div>
  );
}
