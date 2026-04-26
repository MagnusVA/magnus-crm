"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { usePaginatedQuery, useQuery } from "convex/react";
import { DownloadIcon, PlusIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { usePageTitle } from "@/hooks/use-page-title";
import { OpportunityFilters } from "./opportunity-filters";
import { OpportunitySearchInput } from "./opportunity-search-input";
import { OpportunitiesTable } from "./opportunities-table";

export type StatusFilter =
  | "all"
  | "scheduled"
  | "in_progress"
  | "meeting_overran"
  | "payment_received"
  | "follow_up_scheduled"
  | "reschedule_link_sent"
  | "lost"
  | "canceled"
  | "no_show";

export type SourceFilter = "all" | "calendly" | "side_deal";
export type PeriodFilter = "all" | "today" | "this_week" | "this_month";

const STATUS_FILTERS = new Set<StatusFilter>([
  "all",
  "scheduled",
  "in_progress",
  "meeting_overran",
  "payment_received",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "lost",
  "canceled",
  "no_show",
]);

const SOURCE_FILTERS = new Set<SourceFilter>([
  "all",
  "calendly",
  "side_deal",
]);

const PERIOD_FILTERS = new Set<PeriodFilter>([
  "all",
  "today",
  "this_week",
  "this_month",
]);

function readFilter<T extends string>(
  value: string | null,
  allowed: Set<T>,
  fallback: T,
): T {
  return value && allowed.has(value as T) ? (value as T) : fallback;
}

export function OpportunitiesPageClient() {
  usePageTitle("Opportunities");

  const { isAdmin } = useRole();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() =>
    readFilter(searchParams.get("status"), STATUS_FILTERS, "all"),
  );
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(() =>
    readFilter(searchParams.get("source"), SOURCE_FILTERS, "all"),
  );
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>(() =>
    readFilter(searchParams.get("period"), PERIOD_FILTERS, "all"),
  );
  const [closerFilter, setCloserFilter] = useState<Id<"users"> | "all">(
    () => (searchParams.get("closer") as Id<"users"> | null) ?? "all",
  );
  const [searchTerm, setSearchTerm] = useState("");

  const writeUrl = useCallback(
    (
      next: Partial<{
        status: StatusFilter;
        source: SourceFilter;
        period: PeriodFilter;
        closer: Id<"users"> | "all";
      }>,
    ) => {
      const params = new URLSearchParams(window.location.search);
      const values = {
        status: next.status ?? statusFilter,
        source: next.source ?? sourceFilter,
        period: next.period ?? periodFilter,
        closer: isAdmin ? (next.closer ?? closerFilter) : "all",
      };

      for (const [key, value] of Object.entries(values)) {
        if (value && value !== "all") {
          params.set(key, value);
        } else {
          params.delete(key);
        }
      }

      const queryString = params.toString();
      window.history.replaceState(
        null,
        "",
        `${pathname}${queryString ? `?${queryString}` : ""}`,
      );
    },
    [closerFilter, isAdmin, pathname, periodFilter, sourceFilter, statusFilter],
  );

  const trimmedSearchTerm = searchTerm.trim();
  const isSearching = trimmedSearchTerm.length >= 2;

  const queryArgs = useMemo(
    () => ({
      statusFilter: statusFilter === "all" ? undefined : statusFilter,
      sourceFilter: sourceFilter === "all" ? undefined : sourceFilter,
      periodFilter: periodFilter === "all" ? undefined : periodFilter,
      closerFilter:
        isAdmin && closerFilter !== "all" ? closerFilter : undefined,
    }),
    [closerFilter, isAdmin, periodFilter, sourceFilter, statusFilter],
  );

  const {
    results: paginatedOpportunities,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    api.opportunities.listQueries.listOpportunities,
    isSearching ? "skip" : queryArgs,
    { initialNumItems: 25 },
  );

  const searchResults = useQuery(
    api.opportunities.listQueries.searchOpportunities,
    isSearching
      ? {
          ...queryArgs,
          searchTerm: trimmedSearchTerm,
        }
      : "skip",
  );

  const opportunities = isSearching
    ? (searchResults ?? [])
    : paginatedOpportunities;

  const handleSearchChange = useCallback((term: string) => {
    setSearchTerm(term);
  }, []);

  const handleRowClick = useCallback((opportunityId: Id<"opportunities">) => {
    const detailWindow = window.open(
      `/workspace/opportunities/${opportunityId}`,
      "_blank",
      "noopener,noreferrer",
    );
    if (detailWindow) {
      detailWindow.opener = null;
    }
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Opportunities
          </h1>
          <p className="text-sm text-muted-foreground">
            Browse Calendly-sourced opportunities and side deals in one place.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled title="Coming soon">
            <DownloadIcon data-icon="inline-start" />
            Export CSV
          </Button>
          <Button asChild size="sm">
            <Link href="/workspace/opportunities/new">
              <PlusIcon data-icon="inline-start" />
              New Opportunity
            </Link>
          </Button>
        </div>
      </div>

      <Card className="p-4">
        <div className="flex flex-col gap-4">
          <OpportunitySearchInput
            value={searchTerm}
            onChange={handleSearchChange}
          />
          <OpportunityFilters
            isAdmin={isAdmin}
            statusFilter={statusFilter}
            sourceFilter={sourceFilter}
            periodFilter={periodFilter}
            closerFilter={closerFilter}
            onStatusChange={(value) => {
              setStatusFilter(value);
              writeUrl({ status: value });
            }}
            onSourceChange={(value) => {
              setSourceFilter(value);
              writeUrl({ source: value });
            }}
            onPeriodChange={(value) => {
              setPeriodFilter(value);
              writeUrl({ period: value });
            }}
            onCloserChange={(value) => {
              setCloserFilter(value);
              writeUrl({ closer: value });
            }}
          />
        </div>
      </Card>

      <OpportunitiesTable
        opportunities={opportunities}
        isSearching={isSearching}
        isLoading={
          isSearching
            ? searchResults === undefined
            : paginationStatus === "LoadingFirstPage"
        }
        canLoadMore={!isSearching && paginationStatus === "CanLoadMore"}
        onLoadMore={() => loadMore(25)}
        onRowClick={handleRowClick}
        showCloserColumn={isAdmin}
      />
    </div>
  );
}
