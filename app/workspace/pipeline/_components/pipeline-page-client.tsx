"use client";

import { Suspense, useCallback, useEffect, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { usePaginatedQuery, useQuery } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageTitle } from "@/hooks/use-page-title";
import { downloadCSV } from "@/lib/export-csv";
import type { OpportunityStatus } from "@/lib/status-config";
import { getDateRange } from "@/app/workspace/_components/time-period-filter";
import type { TimePeriod } from "@/app/workspace/_components/time-period-filter";
import { format } from "date-fns";
import { DownloadIcon } from "lucide-react";
import { OpportunitiesTable } from "@/app/workspace/_components/pipeline/opportunities-table";
import { PipelineFilters } from "@/app/workspace/_components/pipeline/pipeline-filters";
import type { PipelinePeriod } from "@/app/workspace/_components/pipeline/pipeline-filters";

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

export function PipelinePageClient() {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <PipelineContent />
    </Suspense>
  );
}

function PipelineContent() {
  usePageTitle("Pipeline");

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { isAdmin } = useRole();

  const statusFilter = searchParams.get("status") ?? "all";
  const closerFilter = searchParams.get("closer") ?? "all";
  const periodFilter = (searchParams.get("period") ?? "all") as PipelinePeriod;

  useEffect(() => {
    if (!isAdmin) {
      router.replace("/workspace/closer");
    }
  }, [isAdmin, router]);

  const setFilter = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value && value !== "all") {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const setStatusFilter = useCallback(
    (value: string) => setFilter("status", value),
    [setFilter],
  );

  const setCloserFilter = useCallback(
    (value: string) => setFilter("closer", value),
    [setFilter],
  );

  const setPeriodFilter = useCallback(
    (value: PipelinePeriod) => setFilter("period", value),
    [setFilter],
  );

  const queryArgs = useMemo(() => {
    const args: {
      statusFilter?: OpportunityStatus;
      assignedCloserId?: Id<"users">;
      periodStart?: number;
      periodEnd?: number;
    } = {};

    if (statusFilter !== "all") {
      args.statusFilter = statusFilter as OpportunityStatus;
    }

    if (closerFilter !== "all") {
      args.assignedCloserId = closerFilter as Id<"users">;
    }

    if (periodFilter !== "all") {
      const { periodStart, periodEnd } = getDateRange(periodFilter as TimePeriod);
      args.periodStart = periodStart;
      args.periodEnd = periodEnd;
    }

    return args;
  }, [closerFilter, statusFilter, periodFilter]);

  const {
    results: opportunities,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    api.opportunities.queries.listOpportunitiesForAdmin,
    isAdmin ? queryArgs : "skip",
    { initialNumItems: 25 },
  );
  const teamMembers = useQuery(
    api.users.queries.listTeamMembers,
    isAdmin ? {} : "skip",
  );

  const closersForFilter = useMemo(() => {
    if (!teamMembers) {
      return [];
    }

    return teamMembers.filter((member) => member.role === "closer");
  }, [teamMembers]);

  if (!isAdmin) {
    return <TableSkeleton />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Pipeline</h1>
          <p className="mt-2 text-muted-foreground">
            View all opportunities across your team
          </p>
        </div>
        {opportunities.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              downloadCSV(
                `pipeline-${format(new Date(), "yyyy-MM-dd")}`,
                ["Lead", "Email", "Closer", "Status", "Created"],
                opportunities.map((opportunity) => [
                  opportunity.leadName ?? "",
                  opportunity.leadEmail ?? "",
                  opportunity.closerName === "Unassigned"
                    ? opportunity.hostCalendlyEmail
                      ? `Unassigned (${opportunity.hostCalendlyEmail})`
                      : "Unassigned"
                    : opportunity.closerName ?? "Unassigned",
                  opportunity.status,
                  format(opportunity.createdAt, "yyyy-MM-dd HH:mm"),
                ]),
              );
            }}
          >
            <DownloadIcon data-icon="inline-start" />
            Export CSV
          </Button>
        ) : null}
      </div>

      {teamMembers === undefined ? (
        <TableSkeleton />
      ) : (
        <PipelineFilters
          statusFilter={statusFilter}
          closerFilter={closerFilter}
          periodFilter={periodFilter}
          closers={closersForFilter}
          onStatusChange={setStatusFilter}
          onCloserChange={setCloserFilter}
          onPeriodChange={setPeriodFilter}
        />
      )}

      {paginationStatus === "LoadingFirstPage" ? (
        <TableSkeleton />
      ) : (
        <OpportunitiesTable
          opportunities={opportunities}
          canLoadMore={paginationStatus === "CanLoadMore"}
          isLoadingMore={paginationStatus === "LoadingMore"}
          onLoadMore={() => loadMore(25)}
          showCloserColumn
          meetingBasePath="/workspace/pipeline/meetings"
        />
      )}
    </div>
  );
}
