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
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import {
  OpsCollapsibleRow,
  OpsSearchableList,
} from "@/app/workspace/_components/ops-searchable-list";

const PAGE_SIZE = 25;

type SalesCallRow = FunctionReturnType<
  typeof api.operations.salesCallsDashboard.searchSalesCallsMeetings
>[number];

export type SalesCallsWindow = {
  start: number;
  end: number;
};

export type CloserFilterOption = {
  /** `users` document id as a string. */
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
  SalesCallRow["meetingStatus"],
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

function MeetingSummary({ row }: { row: SalesCallRow }) {
  const status = MEETING_STATUS_META[row.meetingStatus];
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="min-w-0 flex-1 truncate font-medium">{row.leadName}</span>
      <MemberIdentity
        className="hidden w-44 shrink-0 md:flex"
        identity={row.assignedCloser}
        textClassName="text-xs text-muted-foreground"
      />
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

function MeetingDetail({ row }: { row: SalesCallRow }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        <DetailField label="Scheduled at">
          <span className="tabular-nums">{formatDate(row.scheduledAt)}</span>
        </DetailField>
        <DetailField label="Phone closer">
          <MemberIdentity identity={row.assignedCloser} />
        </DetailField>
        <DetailField label="Opportunity status">
          {row.opportunityStatus ? titleCase(row.opportunityStatus) : "Unlinked"}
        </DetailField>
        <DetailField label="Booking program">
          {row.bookingProgramName ?? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default text-muted-foreground">—</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-pretty">
                No booked program mapped for this meeting&apos;s Calendly event
                type.
              </TooltipContent>
            </Tooltip>
          )}
        </DetailField>
        <DetailField label="Sold program">
          {row.soldProgramName ?? "—"}
        </DetailField>
        <DetailField label="DM team">
          {row.attributionTeamName ?? "—"}
        </DetailField>
        <DetailField label="DM closer">{row.dmCloserName ?? "—"}</DetailField>
        <DetailField label="Setter">{row.slackUserLabel ?? "—"}</DetailField>
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
 * Collapsible meetings section for the Phone Sales Ops page. Shares the exact
 * server-derived epoch-ms window with getSalesCallsDashboard so the cards,
 * tables, and this list always cover the same scheduled-at period. A debounced
 * search of two or more characters switches from the paginated list
 * (listPhoneSalesMeetings) to the search query (searchSalesCallsMeetings).
 */
export function SalesCallsDetailsList({
  window,
  closerOptions,
}: {
  window: SalesCallsWindow | undefined;
  closerOptions: CloserFilterOption[] | undefined;
}) {
  const [search, setSearch] = useState("");
  const [closerFilter, setCloserFilter] = useState<string>("all");

  const trimmedSearch = search.trim();
  const isSearching = trimmedSearch.length >= 2;

  const closerArg = useMemo(
    () =>
      closerFilter === "all"
        ? {}
        : { closerId: closerFilter as Id<"users"> },
    [closerFilter],
  );

  const paginatedArgs = useMemo(
    () =>
      window === undefined
        ? undefined
        : {
            scheduledFrom: window.start,
            scheduledTo: window.end,
            ...closerArg,
          },
    [window, closerArg],
  );

  const paginated = usePaginatedQuery(
    api.operations.phoneSales.listPhoneSalesMeetings,
    paginatedArgs === undefined || isSearching ? "skip" : paginatedArgs,
    { initialNumItems: PAGE_SIZE },
  );

  const searchResults = useQuery(
    api.operations.salesCallsDashboard.searchSalesCallsMeetings,
    window !== undefined && isSearching
      ? {
          searchTerm: trimmedSearch,
          start: window.start,
          end: window.end,
          ...closerArg,
        }
      : "skip",
  );

  const rows: SalesCallRow[] = isSearching
    ? (searchResults ?? [])
    : paginated.results;
  const isLoading =
    window === undefined ||
    (isSearching
      ? searchResults === undefined
      : paginated.status === "LoadingFirstPage");
  const isLoadingMore = !isSearching && paginated.status === "LoadingMore";

  return (
    <OpsSearchableList
      title="Meetings"
      searchPlaceholder="Search by lead or prospect name"
      searchValue={search}
      onSearchChange={setSearch}
      isLoading={isLoading}
      emptyMessage={
        rows.length === 0
          ? isSearching
            ? "No meetings match your search in this range."
            : closerFilter === "all"
              ? "No meetings in this range."
              : "No meetings for this phone closer in this range."
          : undefined
      }
      headerRight={
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <Select value={closerFilter} onValueChange={setCloserFilter}>
                <SelectTrigger
                  aria-label="Filter by phone closer"
                  className="w-44"
                  size="sm"
                >
                  <SelectValue placeholder="All phone closers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All phone closers</SelectItem>
                    {(closerOptions ?? []).map((option) => (
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
            Show only meetings assigned to one phone closer in this range.
          </TooltipContent>
        </Tooltip>
      }
    >
      {rows.map((row) => (
        <OpsCollapsibleRow
          key={row.meetingId}
          summary={<MeetingSummary row={row} />}
        >
          <MeetingDetail row={row} />
        </OpsCollapsibleRow>
      ))}
      <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          Showing {rows.length} meeting{rows.length === 1 ? "" : "s"}
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
