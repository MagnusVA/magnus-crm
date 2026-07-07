"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowUpRightIcon, LoaderCircleIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { InitialSourceBadge } from "@/app/workspace/_components/initial-source-badge";
import {
  OpsCollapsibleRow,
  OpsSearchableList,
} from "@/app/workspace/_components/ops-searchable-list";

const PAGE_SIZE = 25;

type BookedCallRow = FunctionReturnType<
  typeof api.operations.bookedCallsDashboard.searchBookedCallsDetails
>[number];

export type BookedCallsWindow = {
  start: number;
  end: number;
};

export type DmCloserFilterOption = {
  /** `dmClosers` document id as a string. */
  key: string;
  label: string;
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const summaryDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const incomeFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

function formatDate(value?: number | null) {
  return value ? dateTimeFormatter.format(new Date(value)) : "—";
}

function titleCase(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const MEETING_STATUS_META: Record<
  BookedCallRow["meetingStatus"],
  { label: string; variant: "outline" | "secondary" | "muted" | "destructive" }
> = {
  scheduled: { label: "Scheduled", variant: "outline" },
  completed: { label: "Completed", variant: "secondary" },
  canceled: { label: "Canceled", variant: "muted" },
  no_show: { label: "No Show", variant: "destructive" },
};

function DetailField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  );
}

function BookingSummary({ row }: { row: BookedCallRow }) {
  const status = MEETING_STATUS_META[row.meetingStatus];
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{row.leadLabel}</span>
        {row.leadHandle ? (
          <span className="truncate text-xs text-muted-foreground">
            {row.leadHandle}
          </span>
        ) : null}
      </div>
      <span className="hidden w-36 min-w-0 shrink-0 truncate text-xs text-muted-foreground md:block">
        {row.dmCloserLabel ?? "—"}
      </span>
      <InitialSourceBadge source={row.initialSource} className="hidden sm:flex" />
      <Tooltip>
        <TooltipTrigger asChild>
          <time
            className="hidden shrink-0 cursor-default text-xs text-muted-foreground tabular-nums sm:block"
            dateTime={new Date(row.scheduledAt).toISOString()}
          >
            {summaryDateFormatter.format(row.scheduledAt)}
          </time>
        </TooltipTrigger>
        <TooltipContent>Scheduled {formatDate(row.scheduledAt)}</TooltipContent>
      </Tooltip>
      <Badge className="shrink-0" variant={status.variant}>
        {status.label}
      </Badge>
    </div>
  );
}

function BookingDetail({ row }: { row: BookedCallRow }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        <DetailField label="Booked at">
          <span className="tabular-nums">{formatDate(row.bookedAt)}</span>
        </DetailField>
        <DetailField label="Scheduled at">
          <span className="tabular-nums">{formatDate(row.scheduledAt)}</span>
        </DetailField>
        <DetailField label="Program">{row.programName ?? "—"}</DetailField>
        <DetailField label="DM team">
          {row.attributionTeamLabel ?? "—"}
        </DetailField>
        <DetailField label="DM closer">{row.dmCloserLabel ?? "—"}</DetailField>
        <DetailField label="Opportunity status">
          {row.opportunityStatus ? titleCase(row.opportunityStatus) : "Unlinked"}
        </DetailField>
        <DetailField label="Initial source">
          <InitialSourceBadge source={row.initialSource} />
        </DetailField>
        <DetailField label="Self-reported income">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-default tabular-nums">
                {row.selfReportedIncome === null
                  ? "—"
                  : incomeFormatter.format(row.selfReportedIncome)}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-pretty">
              Self-reported by the lead — editable in the DM portal.
            </TooltipContent>
          </Tooltip>
        </DetailField>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button asChild variant="outline" size="sm">
          <Link
            href={
              row.leadId
                ? `/workspace/leads-customers/${row.leadId}?opportunityId=${row.opportunityId}`
                : `/workspace/opportunities/${row.opportunityId}`
            }
          >
            Open opportunity
            <ArrowUpRightIcon data-icon="inline-end" />
          </Link>
        </Button>
        {row.leadId ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={`/workspace/leads-customers/${row.leadId}`}>
              Open lead
              <ArrowUpRightIcon data-icon="inline-end" />
            </Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Collapsible bookings section for the Booked Calls page. Shares the exact
 * server-derived epoch-ms window with the dashboard query so the charts and
 * this list always cover the same booked-at period. A debounced search of two
 * or more characters switches from the paginated list to the search query.
 */
export function BookedCallsDetailsList({
  window,
  dmCloserOptions,
}: {
  window: BookedCallsWindow | undefined;
  dmCloserOptions: DmCloserFilterOption[] | undefined;
}) {
  const [search, setSearch] = useState("");
  const [dmCloserFilter, setDmCloserFilter] = useState<string>("all");

  const trimmedSearch = search.trim();
  const isSearching = trimmedSearch.length >= 2;

  const baseArgs = useMemo(
    () =>
      window === undefined
        ? undefined
        : {
            start: window.start,
            end: window.end,
            ...(dmCloserFilter === "all"
              ? {}
              : { dmCloserId: dmCloserFilter as Id<"dmClosers"> }),
          },
    [window, dmCloserFilter],
  );

  const paginated = usePaginatedQuery(
    api.operations.bookedCallsDashboard.listBookedCallsDetails,
    baseArgs === undefined || isSearching ? "skip" : baseArgs,
    { initialNumItems: PAGE_SIZE },
  );

  const searchResults = useQuery(
    api.operations.bookedCallsDashboard.searchBookedCallsDetails,
    baseArgs !== undefined && isSearching
      ? { ...baseArgs, searchTerm: trimmedSearch }
      : "skip",
  );

  const rows: BookedCallRow[] = isSearching
    ? (searchResults ?? [])
    : paginated.results;
  const isLoading =
    baseArgs === undefined ||
    (isSearching
      ? searchResults === undefined
      : paginated.status === "LoadingFirstPage");
  const isLoadingMore = !isSearching && paginated.status === "LoadingMore";

  return (
    <OpsSearchableList
      title="Bookings"
      searchPlaceholder="Search by lead or prospect name"
      searchValue={search}
      onSearchChange={setSearch}
      isLoading={isLoading}
      emptyMessage={
        rows.length === 0
          ? isSearching
            ? "No bookings match your search in this range."
            : dmCloserFilter === "all"
              ? "No bookings in this range."
              : "No bookings for this DM closer in this range."
          : undefined
      }
      headerRight={
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <Select value={dmCloserFilter} onValueChange={setDmCloserFilter}>
                <SelectTrigger
                  aria-label="Filter by DM closer"
                  className="w-44"
                  size="sm"
                >
                  <SelectValue placeholder="All DM closers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All DM closers</SelectItem>
                    {(dmCloserOptions ?? []).map((option) => (
                      <SelectItem key={option.key} value={option.key}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-pretty" side="bottom">
            Show only bookings attributed to one DM closer in this range.
          </TooltipContent>
        </Tooltip>
      }
    >
      {rows.map((row) => (
        <OpsCollapsibleRow
          key={row.meetingId}
          summary={<BookingSummary row={row} />}
        >
          <BookingDetail row={row} />
        </OpsCollapsibleRow>
      ))}
      <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          Showing {rows.length} booking{rows.length === 1 ? "" : "s"}
          {isSearching
            ? " matching your search"
            : paginated.status === "Exhausted"
              ? " (all loaded)"
              : ""}
        </p>
        {!isSearching && paginated.status === "CanLoadMore" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => paginated.loadMore(PAGE_SIZE)}
          >
            <LoaderCircleIcon aria-hidden="true" data-icon="inline-start" />
            Load More
          </Button>
        ) : null}
        {isLoadingMore ? (
          <div
            className="flex items-center gap-2 text-xs text-muted-foreground"
            role="status"
          >
            <Spinner data-icon="inline-start" />
            Loading more…
          </div>
        ) : null}
      </div>
    </OpsSearchableList>
  );
}
