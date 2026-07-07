"use client";

import { useMemo, useState } from "react";
import { usePaginatedQuery } from "convex/react";
import {
  ChevronDownIcon,
  ClipboardListIcon,
  ExternalLinkIcon,
  InboxIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { LeadGenFilters } from "./lead-gen-admin-page-client";
import { VoidSubmissionDialog } from "./void-submission-dialog";

const PAGE_SIZE = 25;
const DAY_MS = 24 * 60 * 60 * 1000;
const BUSINESS_DAY_START_UTC_HOUR = 7;

type RawSubmissionRow = {
  submissionId: Id<"leadGenSubmissions">;
  prospectId: Id<"leadGenProspects">;
  submittedAt: number;
  createdAt: number;
  workerId: Id<"leadGenWorkers">;
  workerDisplayName: string | null;
  workerEmail: string | null;
  teamId: Id<"attributionTeams"> | null;
  teamName: string | null;
  source: "instagram" | "meta_business";
  normalizedHandle: string | null;
  rawHandle: string | null;
  profileUrl: string | null;
  originKind: string;
  originValue: string | null;
  originRankable: boolean;
  clientSubmissionKey: string | null;
  voidedAt: number | null;
  voidReason: string | null;
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const submittedDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "2-digit",
});

const submittedTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function parseDayKey(dayKey: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return null;

  const [year, month, day] = dayKey.split("-").map(Number);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }

  return { day, month, year };
}

function addDays(dayKey: string, days: number) {
  const parsed = parseDayKey(dayKey);
  if (!parsed) return null;

  const timestamp =
    Date.UTC(parsed.year, parsed.month - 1, parsed.day) + days * DAY_MS;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dayKeyToBusinessStartUtc(dayKey: string) {
  const parsed = parseDayKey(dayKey);
  if (!parsed) return null;

  return Date.UTC(
    parsed.year,
    parsed.month - 1,
    parsed.day,
    BUSINESS_DAY_START_UTC_HOUR,
  );
}

function buildRawQueryArgs(filters: LeadGenFilters) {
  const startTimestamp = dayKeyToBusinessStartUtc(filters.startDayKey);
  const nextEndDayKey = addDays(filters.endDayKey, 1);
  const nextEndTimestamp = nextEndDayKey
    ? dayKeyToBusinessStartUtc(nextEndDayKey)
    : null;

  if (
    startTimestamp == null ||
    nextEndTimestamp == null ||
    nextEndTimestamp <= startTimestamp
  ) {
    return "skip" as const;
  }

  return {
    startTimestamp,
    endTimestamp: nextEndTimestamp - 1,
    ...(filters.source ? { source: filters.source } : {}),
  };
}

export function RawSubmissionsTable({ filters }: { filters: LeadGenFilters }) {
  const [isOpen, setIsOpen] = useState(false);
  const queryArgs = useMemo(() => buildRawQueryArgs(filters), [filters]);
  const isValidRange = queryArgs !== "skip";
  const paginatedQueryArgs = isOpen ? queryArgs : "skip";
  const {
    results,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    api.leadGen.exports.listRawSubmissionExportPage,
    paginatedQueryArgs,
    { initialNumItems: PAGE_SIZE },
  );
  const rows = results as RawSubmissionRow[];
  const isInitialLoading =
    isOpen && isValidRange && paginationStatus === "LoadingFirstPage";
  const isLoadingMore = paginationStatus === "LoadingMore";
  const badgeLabel = !isOpen
    ? "Not loaded"
    : !isValidRange
      ? "Invalid range"
    : isInitialLoading
      ? "Loading"
      : `${rows.length} loaded`;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card className="min-w-0" size="sm">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-col gap-1">
              <CardTitle>Raw Submissions</CardTitle>
              <CardDescription className="text-xs">
                Source rows for the current filters, including voided audit
                state.
              </CardDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge className="w-fit" variant="outline">
                {badgeLabel}
              </Badge>
              <CollapsibleTrigger asChild>
                <Button
                  aria-label={
                    isOpen
                      ? "Collapse raw submissions"
                      : "Expand raw submissions"
                  }
                  size="sm"
                  variant="outline"
                >
                  <ChevronDownIcon
                    aria-hidden="true"
                    className={cn(
                      "transition-transform",
                      isOpen && "rotate-180",
                    )}
                    data-icon="inline-start"
                  />
                  {isOpen ? "Hide" : "Show"}
                </Button>
              </CollapsibleTrigger>
            </div>
          </div>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="min-w-0">
            {!isValidRange ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <InboxIcon aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>Select a Valid Range</EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  Raw submissions need a start day on or before an end day.
                </EmptyContent>
              </Empty>
            ) : isInitialLoading ? (
              <div aria-label="Loading raw submissions" role="status">
                <Skeleton className="h-[420px] w-full" />
              </div>
            ) : rows.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ClipboardListIcon aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>No Raw Submissions</EmptyTitle>
                </EmptyHeader>
                <EmptyContent>No raw rows match these filters.</EmptyContent>
              </Empty>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="rounded-lg border">
                  <Table className="table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-28">Submitted</TableHead>
                        <TableHead className="w-[18%]">Prospect</TableHead>
                        <TableHead className="w-[20%]">
                          Specialist / Team
                        </TableHead>
                        <TableHead>Origin</TableHead>
                        <TableHead className="w-24">Status</TableHead>
                        <TableHead className="w-12 text-right">
                          Action
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => (
                        <TableRow
                          data-state={row.voidedAt ? "selected" : undefined}
                          key={row.submissionId}
                        >
                          <TableCell className="tabular-nums">
                            <time
                              className="flex flex-col gap-0.5 text-xs leading-tight"
                              dateTime={new Date(
                                row.submittedAt,
                              ).toISOString()}
                            >
                              <span>
                                {submittedDateFormatter.format(
                                  row.submittedAt,
                                )}
                              </span>
                              <span className="text-muted-foreground">
                                {submittedTimeFormatter.format(
                                  row.submittedAt,
                                )}
                              </span>
                            </time>
                          </TableCell>
                          <TableCell className="max-w-0">
                            <ProspectCell row={row} />
                          </TableCell>
                          <TableCell className="max-w-0">
                            <WorkerTeamCell row={row} />
                          </TableCell>
                          <TableCell className="max-w-0">
                            <OriginCell row={row} />
                          </TableCell>
                          <TableCell className="max-w-0">
                            <SubmissionStatus row={row} />
                          </TableCell>
                          <TableCell className="text-right">
                            {row.voidedAt ? (
                              <span
                                className="text-xs text-muted-foreground"
                                title="No action"
                              >
                                -
                              </span>
                            ) : (
                              <VoidSubmissionDialog
                                compactTrigger
                                prospectLabel={getProspectLabel(row)}
                                submissionId={row.submissionId}
                              />
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">
                    Showing {rows.length} submission
                    {rows.length === 1 ? "" : "s"}
                    {paginationStatus === "Exhausted" ? " (all loaded)" : ""}
                  </p>
                  <div className="flex items-center gap-2">
                    {isLoadingMore ? (
                      <div
                        className="flex items-center gap-2 text-xs text-muted-foreground"
                        role="status"
                      >
                        <Spinner data-icon="inline-start" />
                        Loading more…
                      </div>
                    ) : null}
                    {paginationStatus === "CanLoadMore" ? (
                      <Button
                        disabled={isLoadingMore}
                        size="sm"
                        variant="outline"
                        onClick={() => loadMore(PAGE_SIZE)}
                      >
                        {isLoadingMore ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <LoaderCircleIcon
                            aria-hidden="true"
                            data-icon="inline-start"
                          />
                        )}
                        Load More
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function ProspectCell({ row }: { row: RawSubmissionRow }) {
  const label = getProspectLabel(row);

  if (!row.profileUrl) {
    return (
      <div className="flex min-w-0 flex-col gap-1" title={row.prospectId}>
        <span className="truncate font-medium">{label}</span>
        {row.rawHandle && row.rawHandle !== label ? (
          <span className="truncate text-xs text-muted-foreground">
            {row.rawHandle}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1" title={row.prospectId}>
      <a
        className="flex min-w-0 items-center gap-2 truncate font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        href={row.profileUrl}
        rel="noreferrer"
        target="_blank"
      >
        <span className="truncate">{label}</span>
        <ExternalLinkIcon aria-hidden="true" />
      </a>
      {row.rawHandle && row.rawHandle !== label ? (
        <span className="truncate text-xs text-muted-foreground">
          {row.rawHandle}
        </span>
      ) : null}
    </div>
  );
}

function WorkerTeamCell({ row }: { row: RawSubmissionRow }) {
  const workerLabel =
    row.workerDisplayName ?? row.workerEmail ?? "Specialist";

  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      title={row.workerEmail ?? undefined}
    >
      <span className="truncate font-medium">{workerLabel}</span>
      <span className="truncate text-xs text-muted-foreground">
        {row.teamName ?? "No Team"}
      </span>
    </div>
  );
}

function OriginCell({ row }: { row: RawSubmissionRow }) {
  const originText = row.originValue
    ? formatOriginValue(row.originValue)
    : formatOrigin(row.originKind);
  const isExternalOrigin =
    typeof row.originValue === "string" && /^https?:\/\//.test(row.originValue);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <Badge className="shrink-0" variant="secondary">
          {formatSource(row.source)}
        </Badge>
        <Badge className="shrink-0" variant="outline">
          {formatOrigin(row.originKind)}
        </Badge>
        {isExternalOrigin ? (
          <a
            className="flex min-w-0 items-center gap-2 truncate underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href={row.originValue ?? undefined}
            rel="noreferrer"
            target="_blank"
            title={row.originValue ?? undefined}
          >
            <span className="truncate">{originText}</span>
            <ExternalLinkIcon aria-hidden="true" />
          </a>
        ) : (
          <span className="truncate">{originText}</span>
        )}
      </div>
      {row.clientSubmissionKey ? (
        <span className="hidden truncate text-xs text-muted-foreground xl:block">
          Key: {row.clientSubmissionKey}
        </span>
      ) : null}
    </div>
  );
}

function SubmissionStatus({ row }: { row: RawSubmissionRow }) {
  if (!row.voidedAt) {
    return <Badge variant="secondary">Active</Badge>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Badge className="w-fit" variant="destructive">
        Voided
      </Badge>
      <span className="truncate text-xs text-muted-foreground">
        {dateTimeFormatter.format(row.voidedAt)}
      </span>
      {row.voidReason ? (
        <span className="max-w-64 truncate text-xs text-muted-foreground">
          {row.voidReason}
        </span>
      ) : null}
    </div>
  );
}

function getProspectLabel(row: RawSubmissionRow) {
  if (row.normalizedHandle) return `@${row.normalizedHandle}`;
  return row.rawHandle ?? "Prospect";
}

function formatSource(source: RawSubmissionRow["source"]) {
  return source === "meta_business" ? "Meta Business" : "Instagram";
}

function formatOrigin(originKind: string) {
  if (originKind === "source_only") return "No Origin";

  return originKind
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatOriginValue(originValue: string) {
  try {
    const url = new URL(originValue);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname}`;
  } catch {
    return originValue;
  }
}
