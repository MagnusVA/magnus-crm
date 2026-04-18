"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
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
  isValidOpportunityStatus,
  type OpportunityStatus,
} from "@/lib/status-config";
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

  const statusParam = searchParams.get("status");
  const initialStatus =
    statusParam && isValidOpportunityStatus(statusParam)
      ? statusParam
      : undefined;

  const periodParam = searchParams.get("period");
  const initialPeriod: PipelinePeriod = isValidPeriod(periodParam)
    ? periodParam
    : "all";

  const [statusFilter, setStatusFilter] = useState<
    OpportunityStatus | undefined
  >(initialStatus);
  const [periodFilter, setPeriodFilter] =
    useState<PipelinePeriod>(initialPeriod);

  // Update URL (via history.replaceState) without triggering a Next.js
  // navigation — that would re-run the async server component and flash the
  // full-page loading skeleton.
  const writeUrl = useCallback(
    (next: { status?: OpportunityStatus | undefined; period?: PipelinePeriod }) => {
      const params = new URLSearchParams(window.location.search);
      const nextStatus = "status" in next ? next.status : statusFilter;
      const nextPeriod = "period" in next ? next.period : periodFilter;

      if (nextStatus) {
        params.set("status", nextStatus);
      } else {
        params.delete("status");
      }

      if (nextPeriod && nextPeriod !== "all") {
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
    [pathname, statusFilter, periodFilter],
  );

  const handleStatusChange = useCallback(
    (value: string) => {
      const next =
        value === "all" ? undefined : (value as OpportunityStatus);
      setStatusFilter(next);
      posthog.capture("pipeline_status_filter_changed", {
        status: next ?? "all",
      });
      writeUrl({ status: next });
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
        statusFilter={statusFilter ?? "all"}
        periodFilter={periodFilter}
        onStatusChange={handleStatusChange}
        onPeriodChange={handlePeriodChange}
        counts={pipelineSummary.counts}
        total={pipelineSummary.total}
      />

      <Suspense fallback={<TableSkeleton />}>
        <CloserOpportunitiesTable
          statusFilter={statusFilter}
          periodFilter={periodFilter}
          onClearFilter={() => handleStatusChange("all")}
        />
      </Suspense>
    </div>
  );
}

function CloserOpportunitiesTable({
  statusFilter,
  periodFilter,
  onClearFilter,
}: {
  statusFilter: OpportunityStatus | undefined;
  periodFilter: PipelinePeriod;
  onClearFilter: () => void;
}) {
  const queryArgs = useMemo(() => {
    const args: {
      statusFilter?: OpportunityStatus;
      periodStart?: number;
      periodEnd?: number;
    } = {};

    if (statusFilter) {
      args.statusFilter = statusFilter;
    }

    if (periodFilter !== "all") {
      const { periodStart, periodEnd } = getDateRange(
        periodFilter as TimePeriod,
      );
      args.periodStart = periodStart;
      args.periodEnd = periodEnd;
    }

    return args;
  }, [statusFilter, periodFilter]);

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
        statusFilter
          ? `No ${statusFilter.replace(/_/g, " ")} opportunities`
          : "No opportunities yet"
      }
      description={
        statusFilter
          ? "Try selecting a different status filter above."
          : "Opportunities will appear here when leads book meetings through Calendly."
      }
      icon={KanbanIcon}
    >
      {statusFilter && (
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
      meetingBasePath="/workspace/closer/meetings"
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
