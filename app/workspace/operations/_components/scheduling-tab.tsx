"use client";

import { useMemo, useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { AlertCircleIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  buildSchedulingPrimaryArgs,
  getSchedulingValueOptions,
  OperationsFilterBar,
  SCHEDULING_PRIMARY_FILTER_OPTIONS,
  type SchedulingPrimaryFilter,
} from "./operations-filter-bar";
import {
  getOperationsPeriodRange,
  type OperationsPeriod,
} from "./operations-period";
import { SchedulingTable, type SchedulingRow } from "./scheduling-table";

export function SchedulingTab() {
  const [period, setPeriod] = useState<OperationsPeriod>("this_week");
  const [primaryFilter, setPrimaryFilter] =
    useState<SchedulingPrimaryFilter>("none");
  const [primaryValue, setPrimaryValue] = useState("all");

  const filterOptions = useQuery(
    api.operations.qualifications.listQualificationFilterOptions,
    {},
  );

  const queryArgs = useMemo(() => {
    const range = getOperationsPeriodRange(period);
    return {
      ...buildSchedulingPrimaryArgs(primaryFilter, primaryValue),
      scheduledFrom: range.after,
      scheduledTo: range.before,
    };
  }, [period, primaryFilter, primaryValue]);

  const valueOptions = useMemo(
    () => getSchedulingValueOptions(primaryFilter, filterOptions),
    [filterOptions, primaryFilter],
  );

  const paginated = usePaginatedQuery(
    api.operations.scheduling.listSchedulingQueue,
    queryArgs,
    { initialNumItems: 25 },
  );

  const rows = paginated.results as SchedulingRow[];

  return (
    <div className="flex flex-col gap-4">
      <OperationsFilterBar
        period={period}
        onPeriodChange={setPeriod}
        primaryFilter={primaryFilter}
        onPrimaryFilterChange={setPrimaryFilter}
        primaryValue={primaryValue}
        onPrimaryValueChange={setPrimaryValue}
        primaryFilterOptions={SCHEDULING_PRIMARY_FILTER_OPTIONS}
        valueOptions={valueOptions}
        note="Scheduling filters use first meeting time; booked time is displayed separately."
      />

      <Alert>
        <AlertCircleIcon />
        <AlertTitle>Exact filters only</AlertTitle>
        <AlertDescription>
          Scheduling supports one indexed primary dimension with a scheduled
          date period. Additional combinations should be reviewed from exports
          or reports.
        </AlertDescription>
      </Alert>

      <SchedulingTable
        rows={rows}
        isLoading={paginated.status === "LoadingFirstPage"}
      />

      {paginated.status === "CanLoadMore" ? (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => paginated.loadMore(25)}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
