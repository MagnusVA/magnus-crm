"use client";

import { useCallback, useDeferredValue, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { usePaginatedQuery, useQuery } from "convex/react";
import { AlertCircleIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { QualificationFilters, type QualificationPrimaryFilter } from "./qualification-filters";
import { QualificationRepairSheet } from "./qualification-repair-sheet";
import { QualificationTable, type QualificationRow } from "./qualification-table";
import {
  getOperationsPeriodRange,
  type OperationsPeriod,
} from "./operations-period";

type OpportunityStatus =
  | "qualified_pending"
  | "scheduled"
  | "payment_received"
  | "follow_up_scheduled"
  | "reschedule_link_sent"
  | "lost"
  | "canceled"
  | "no_show";

function buildPrimaryArgs(filter: QualificationPrimaryFilter, value: string) {
  if (filter === "none" || value === "all") {
    return {};
  }
  if (filter === "status") {
    return { statusFilter: value as OpportunityStatus };
  }
  if (filter === "bookingProgram") {
    return { bookingProgramId: value as Id<"tenantPrograms"> };
  }
  if (filter === "soldProgram") {
    return { soldProgramId: value as Id<"tenantPrograms"> };
  }
  if (filter === "slackUser") {
    return { slackUserId: value };
  }
  if (filter === "attributionTeam") {
    return { attributionTeamId: value as Id<"attributionTeams"> };
  }
  if (filter === "dmCloser") {
    return { dmCloserId: value as Id<"dmClosers"> };
  }
  return {};
}

function readReportRange(searchParams: { get(name: string): string | null }) {
  const after = Number(searchParams.get("qualifiedAfter"));
  const before = Number(searchParams.get("qualifiedBefore"));
  if (Number.isFinite(after) && Number.isFinite(before) && after < before) {
    return { after, before };
  }
  return null;
}

function VisibleStats({ rows }: { rows: QualificationRow[] }) {
  const stats = useMemo(() => {
    let booked = 0;
    let unlinked = 0;
    let mapped = 0;
    for (const row of rows) {
      if (row.firstMeetingAt) booked += 1;
      if (!row.opportunityId || row.resultKind === "unlinked") unlinked += 1;
      if (row.attributionResolution === "mapped") mapped += 1;
    }
    return { visible: rows.length, booked, unlinked, mapped };
  }, [rows]);

  return (
    <div className="grid gap-3 sm:grid-cols-4">
      <Metric label="Visible rows" value={stats.visible} />
      <Metric label="Booked" value={stats.booked} />
      <Metric label="Mapped attribution" value={stats.mapped} />
      <Metric label="Needs repair" value={stats.unlinked} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function QualificationTab() {
  const searchParams = useSearchParams();
  const initialSlackUserId = searchParams.get("slackUserId");
  const [searchTerm, setSearchTerm] = useState("");
  const [period, setPeriod] = useState<OperationsPeriod>("all");
  const [primaryFilter, setPrimaryFilter] =
    useState<QualificationPrimaryFilter>(
      initialSlackUserId ? "slackUser" : "none",
    );
  const [primaryValue, setPrimaryValue] = useState(initialSlackUserId ?? "all");
  const [reportRange, setReportRange] = useState(() =>
    readReportRange(searchParams),
  );
  const [repairRow, setRepairRow] = useState<QualificationRow | null>(null);
  const deferredSearchTerm = useDeferredValue(searchTerm);

  const filterOptions = useQuery(
    api.operations.qualifications.listQualificationFilterOptions,
    {},
  );

  const handlePrimaryFilterChange = useCallback(
    (value: QualificationPrimaryFilter) => {
      setPrimaryFilter(value);
      setPrimaryValue("all");
    },
    [],
  );

  const queryArgs = useMemo(() => {
    const range = reportRange ?? getOperationsPeriodRange(period);
    return {
      ...buildPrimaryArgs(primaryFilter, primaryValue),
      qualifiedAfter: range.after,
      qualifiedBefore: range.before,
    };
  }, [period, primaryFilter, primaryValue, reportRange]);

  const trimmedSearchTerm = deferredSearchTerm.trim();
  const isSearching = trimmedSearchTerm.length >= 2;

  const paginated = usePaginatedQuery(
    api.operations.qualifications.listQualificationQueue,
    isSearching ? "skip" : queryArgs,
    { initialNumItems: 25 },
  );

  const searchResults = useQuery(
    api.operations.qualifications.searchQualificationQueue,
    isSearching ? { ...queryArgs, searchTerm: trimmedSearchTerm } : "skip",
  );

  const rows = (
    isSearching ? (searchResults ?? []) : paginated.results
  ) as QualificationRow[];
  const isLoading = isSearching
    ? searchResults === undefined
    : paginated.status === "LoadingFirstPage";

  return (
    <div className="flex flex-col gap-4">
      <QualificationFilters
        searchTerm={searchTerm}
        onSearchTermChange={setSearchTerm}
        period={period}
        onPeriodChange={(next) => {
          setPeriod(next);
          setReportRange(null);
        }}
        primaryFilter={primaryFilter}
        onPrimaryFilterChange={handlePrimaryFilterChange}
        primaryValue={primaryValue}
        onPrimaryValueChange={setPrimaryValue}
        options={filterOptions}
      />

      <Alert>
        <AlertCircleIcon />
        <AlertTitle>One primary filter at a time</AlertTitle>
        <AlertDescription>
          Qualification rows are served from indexed projections. Combine one
          primary dimension with a period and search term for predictable reads.
        </AlertDescription>
      </Alert>

      {reportRange ? (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>Report range applied</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              This queue is filtered to the qualification event range from the
              Slack Qualifications report link.
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setReportRange(null)}
            >
              Clear range
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <VisibleStats rows={rows} />

      <QualificationTable
        rows={rows}
        isLoading={isLoading}
        onOpenRepair={setRepairRow}
      />

      {!isSearching && paginated.status === "CanLoadMore" ? (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => paginated.loadMore(25)}>
            Load more
          </Button>
        </div>
      ) : null}

      <QualificationRepairSheet
        row={repairRow}
        onOpenChange={(open) => {
          if (!open) {
            setRepairRow(null);
          }
        }}
      />
    </div>
  );
}
