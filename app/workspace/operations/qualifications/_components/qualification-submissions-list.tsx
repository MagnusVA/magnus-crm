"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowUpRightIcon, LoaderCircleIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
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

type SubmissionRow = FunctionReturnType<
  typeof api.operations.qualifications.searchQualificationQueue
>[number];

export type QualificationWindow = {
  qualifiedAfter: number;
  qualifiedBefore: number;
};

const STATUS_OPTIONS = [
  { id: "qualified_pending", name: "Qualified pending" },
  { id: "scheduled", name: "Scheduled" },
  { id: "payment_received", name: "Payment received" },
  { id: "follow_up_scheduled", name: "Follow-up scheduled" },
  { id: "reschedule_link_sent", name: "Reschedule link sent" },
  { id: "lost", name: "Lost" },
  { id: "canceled", name: "Canceled" },
  { id: "no_show", name: "No show" },
] as const;

type OpportunityStatus = (typeof STATUS_OPTIONS)[number]["id"];
type StatusFilterValue = OpportunityStatus | "all";

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

function formatDate(value?: number) {
  return value ? dateTimeFormatter.format(new Date(value)) : "—";
}

function titleCase(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatStatus(value?: string) {
  return value ? titleCase(value) : "Unlinked";
}

function resultKindLabel(value: SubmissionRow["resultKind"]) {
  if (value === "created_opportunity") return "Created opportunity";
  if (value === "duplicate_pending") return "Duplicate pending";
  if (value === "already_booked") return "Already booked";
  return "Unlinked";
}

function isValidStatus(value: string): value is OpportunityStatus {
  return STATUS_OPTIONS.some((option) => option.id === value);
}

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

function SubmissionSummary({ row }: { row: SubmissionRow }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{row.leadLabel}</span>
        <span className="truncate text-xs text-muted-foreground">
          {row.handleSnapshot
            ? `${row.handleSnapshot} · ${titleCase(row.platform)}`
            : titleCase(row.platform)}
        </span>
      </div>
      <div className="hidden w-40 min-w-0 shrink-0 md:block">
        <MemberIdentity identity={row.slackUser} textClassName="text-xs" />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <time
            className="hidden shrink-0 cursor-default text-xs text-muted-foreground tabular-nums sm:block"
            dateTime={new Date(row.qualifiedAt).toISOString()}
          >
            {summaryDateFormatter.format(row.qualifiedAt)}
          </time>
        </TooltipTrigger>
        <TooltipContent>
          Qualified {formatDate(row.qualifiedAt)}
        </TooltipContent>
      </Tooltip>
      <Badge
        className="shrink-0"
        variant={row.opportunityStatus ? "secondary" : "outline"}
      >
        {formatStatus(row.opportunityStatus)}
      </Badge>
    </div>
  );
}

function SubmissionDetail({ row }: { row: SubmissionRow }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        <DetailField label="Qualified by">
          <MemberIdentity identity={row.slackUser} textClassName="text-sm" />
        </DetailField>
        <DetailField label="Qualified at">
          <span className="tabular-nums">{formatDate(row.qualifiedAt)}</span>
        </DetailField>
        <DetailField label="Result">
          {resultKindLabel(row.resultKind)}
        </DetailField>
        <DetailField label="Booked program">
          {row.bookingProgramName ?? "Unmapped"}
        </DetailField>
        <DetailField label="Sold program">
          {row.soldProgramName ?? "—"}
        </DetailField>
        <DetailField label="First meeting">
          <span className="tabular-nums">{formatDate(row.firstMeetingAt)}</span>
        </DetailField>
        <DetailField label="DM team">
          {row.attributionTeamName ?? "—"}
        </DetailField>
        <DetailField label="DM closer">
          {row.dmCloser ? (
            <MemberIdentity identity={row.dmCloser} textClassName="text-sm" />
          ) : (
            <Badge variant="outline">{titleCase(row.attributionResolution)}</Badge>
          )}
        </DetailField>
        <DetailField label="Assigned closer">
          <MemberIdentity
            identity={row.assignedCloser}
            textClassName="text-sm"
          />
        </DetailField>
      </div>
      {row.opportunityId || row.leadId ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {row.opportunityId ? (
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
          ) : null}
          {row.leadId ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/workspace/leads-customers/${row.leadId}`}>
                Open lead
                <ArrowUpRightIcon data-icon="inline-end" />
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Collapsible submissions section for the Qualified Leads page. Shares the
 * exact server-derived epoch-ms window with the dashboard query so the charts
 * and this list always cover the same time period. A debounced search of two
 * or more characters switches from the paginated queue to the search index.
 */
export function QualificationSubmissionsList({
  eventWindow,
}: {
  eventWindow: QualificationWindow | undefined;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("all");

  const trimmedSearch = search.trim();
  const isSearching = trimmedSearch.length >= 2;

  const baseArgs = useMemo(
    () =>
      eventWindow === undefined
        ? undefined
        : {
            ...(statusFilter === "all" ? {} : { statusFilter }),
            qualifiedAfter: eventWindow.qualifiedAfter,
            qualifiedBefore: eventWindow.qualifiedBefore,
          },
    [eventWindow, statusFilter],
  );

  const paginated = usePaginatedQuery(
    api.operations.qualifications.listQualificationQueue,
    baseArgs === undefined || isSearching ? "skip" : baseArgs,
    { initialNumItems: PAGE_SIZE },
  );

  const searchResults = useQuery(
    api.operations.qualifications.searchQualificationQueue,
    baseArgs !== undefined && isSearching
      ? { ...baseArgs, searchTerm: trimmedSearch }
      : "skip",
  );

  const rows: SubmissionRow[] = isSearching
    ? (searchResults ?? [])
    : paginated.results;
  const isLoading =
    baseArgs === undefined ||
    (isSearching
      ? searchResults === undefined
      : paginated.status === "LoadingFirstPage");
  const isLoadingMore = !isSearching && paginated.status === "LoadingMore";

  const handleStatusChange = useCallback((value: string) => {
    setStatusFilter(value === "all" || !isValidStatus(value) ? "all" : value);
  }, []);

  return (
    <OpsSearchableList
      title="Submissions"
      searchPlaceholder="Search lead, handle, status, or program"
      searchValue={search}
      onSearchChange={setSearch}
      isLoading={isLoading}
      emptyMessage={
        rows.length === 0
          ? isSearching
            ? "No submissions match your search in this range."
            : statusFilter === "all"
              ? "No submissions in this range."
              : "No submissions with this status in this range."
          : undefined
      }
      headerRight={
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <Select value={statusFilter} onValueChange={handleStatusChange}>
                <SelectTrigger
                  aria-label="Filter by opportunity status"
                  className="w-44"
                  size="sm"
                >
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All statuses</SelectItem>
                    {STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-pretty" side="bottom">
            Filter submissions to one opportunity status. Rows are served from
            indexed projections, so one primary filter applies at a time.
          </TooltipContent>
        </Tooltip>
      }
    >
      {rows.map((row) => (
        <OpsCollapsibleRow key={row._id} summary={<SubmissionSummary row={row} />}>
          <SubmissionDetail row={row} />
        </OpsCollapsibleRow>
      ))}
      <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          Showing {rows.length} submission{rows.length === 1 ? "" : "s"}
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
