"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { usePaginatedQuery, useQuery } from "convex/react";
import posthog from "posthog-js";
import { KanbanIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  closerPipelineTabFromSearch,
  type CloserPipelineTab,
} from "@/convex/closer/pipelineTabs";
import { DEAL_POSITION_LABELS } from "@/convex/opportunities/stages";
import {
  getDateRange,
  type TimePeriod,
} from "@/app/workspace/_components/time-period-filter";
import {
  PipelineFilters,
  type PipelinePeriod,
} from "@/app/workspace/_components/pipeline/pipeline-filters";
import { OpportunitiesTable } from "@/app/workspace/_components/pipeline/opportunities-table";
import { CloserEmptyState } from "../../_components/closer-empty-state";

const VALID_PERIODS: readonly PipelinePeriod[] = [
  "all",
  "today",
  "this_week",
  "this_month",
];

function isValidPeriod(value: string | null): value is PipelinePeriod {
  return value !== null && (VALID_PERIODS as readonly string[]).includes(value);
}

export function CloserPipelinePageClient() {
  return (
    <Suspense fallback={<PageHeaderSkeleton />}>
      <CloserPipelineContent />
    </Suspense>
  );
}

function CloserPipelineContent() {
  usePageTitle("My Pipeline");
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // `stage=`, or an old `status=` link mapped to the tab its deals are on.
  const initialStage = closerPipelineTabFromSearch(searchParams);

  const periodParam = searchParams.get("period");
  const initialPeriod: PipelinePeriod = isValidPeriod(periodParam)
    ? periodParam
    : "today";

  const [stageFilter, setStageFilter] = useState<CloserPipelineTab | null>(
    initialStage,
  );
  const [periodFilter, setPeriodFilter] =
    useState<PipelinePeriod>(initialPeriod);

  // Update URL (via history.replaceState) without triggering a Next.js
  // navigation — that would re-run the async server component and flash the
  // full-page loading skeleton.
  const writeUrl = useCallback(
    (next: { stage?: CloserPipelineTab | null; period?: PipelinePeriod }) => {
      const params = new URLSearchParams(window.location.search);
      const nextStage = "stage" in next ? next.stage : stageFilter;
      const nextPeriod = "period" in next ? next.period : periodFilter;

      // The URL names the stage, never the old status.
      params.delete("status");
      if (nextStage) {
        params.set("stage", nextStage);
      } else {
        params.delete("stage");
      }

      if (nextPeriod && nextPeriod !== "today") {
        params.set("period", nextPeriod);
      } else {
        params.delete("period");
      }

      const qs = params.toString();
      window.history.replaceState(
        null,
        "",
        `${pathname}${qs ? `?${qs}` : ""}`,
      );
    },
    [pathname, stageFilter, periodFilter],
  );

  // An old `status=` link, or a `stage=` no tab has, opens a tab: write that
  // tab back as `stage=`.
  const hasStaleStageParam =
    searchParams.has("status") ||
    (searchParams.has("stage") && searchParams.get("stage") !== initialStage);
  useEffect(() => {
    if (hasStaleStageParam) {
      writeUrl({});
    }
  }, [hasStaleStageParam, writeUrl]);

  const handleStageChange = useCallback(
    (next: CloserPipelineTab | null) => {
      setStageFilter(next);
      posthog.capture("pipeline_stage_filter_changed", {
        stage: next ?? "all",
      });
      writeUrl({ stage: next });
    },
    [writeUrl],
  );

  const handlePeriodChange = useCallback(
    (value: PipelinePeriod) => {
      setPeriodFilter(value);
      posthog.capture("pipeline_period_filter_changed", { period: value });
      writeUrl({ period: value });
    },
    [writeUrl],
  );

  // No date filter on the pipeline page — these counts are always all-time.
  const pipelineSummary = useQuery(api.closer.dashboard.getPipelineSummary, {});

  if (pipelineSummary === undefined) {
    return <PageHeaderSkeleton />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">My Pipeline</h1>
        <p className="mt-2 text-muted-foreground">
          Track your opportunities and meeting outcomes
        </p>
      </div>

      <PipelineFilters
        stageFilter={stageFilter}
        periodFilter={periodFilter}
        onStageChange={handleStageChange}
        onPeriodChange={handlePeriodChange}
        counts={pipelineSummary.counts}
        total={pipelineSummary.total}
      />

      <Suspense fallback={<TableSkeleton />}>
        <CloserOpportunitiesTable
          stageFilter={stageFilter}
          periodFilter={periodFilter}
          onClearFilter={() => handleStageChange(null)}
        />
      </Suspense>
    </div>
  );
}

function CloserOpportunitiesTable({
  stageFilter,
  periodFilter,
  onClearFilter,
}: {
  stageFilter: CloserPipelineTab | null;
  periodFilter: PipelinePeriod;
  onClearFilter: () => void;
}) {
  const queryArgs = useMemo(() => {
    const args: {
      positionFilter?: CloserPipelineTab;
      periodStart?: number;
      periodEnd?: number;
    } = {};

    if (stageFilter) {
      args.positionFilter = stageFilter;
    }

    if (periodFilter !== "all") {
      const { periodStart, periodEnd } = getDateRange(
        periodFilter as TimePeriod,
      );
      args.periodStart = periodStart;
      args.periodEnd = periodEnd;
    }

    return args;
  }, [stageFilter, periodFilter]);

  const {
    results: opportunities,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    api.closer.pipeline.listMyOpportunities,
    queryArgs,
    { initialNumItems: 25 },
  );

  if (paginationStatus === "LoadingFirstPage") {
    return <TableSkeleton />;
  }

  const emptyState = (
    <CloserEmptyState
      title={
        stageFilter
          ? `No ${DEAL_POSITION_LABELS[stageFilter].toLowerCase()} opportunities`
          : "No opportunities yet"
      }
      description={
        stageFilter
          ? "Try selecting a different stage above."
          : "Opportunities will appear here when leads book meetings through Calendly."
      }
      icon={KanbanIcon}
    >
      {stageFilter && (
        <Button variant="outline" size="sm" onClick={onClearFilter}>
          Show all opportunities
        </Button>
      )}
    </CloserEmptyState>
  );

  return (
    <OpportunitiesTable
      opportunities={opportunities}
      canLoadMore={paginationStatus === "CanLoadMore"}
      isLoadingMore={paginationStatus === "LoadingMore"}
      onLoadMore={() => loadMore(25)}
      emptyState={emptyState}
    />
  );
}

function PageHeaderSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-9 w-full rounded-lg" />
    </div>
  );
}

function TableSkeleton() {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex flex-col gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
