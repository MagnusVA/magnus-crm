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
  buildPhoneSalesPrimaryArgs,
  getPhoneSalesValueOptions,
  OperationsFilterBar,
  PHONE_SALES_PRIMARY_FILTER_OPTIONS,
  type PhoneSalesPrimaryFilter,
} from "./operations-filter-bar";
import {
  getOperationsPeriodRange,
  type OperationsPeriod,
} from "./operations-period";
import {
  PhoneSalesStatCards,
  type PhoneSalesStats,
} from "./phone-sales-stat-cards";
import { PhoneSalesTable, type PhoneSalesRow } from "./phone-sales-table";

function getStatsRange(period: OperationsPeriod) {
  const range = getOperationsPeriodRange(period);
  return {
    scheduledFrom: range.after ?? 0,
    scheduledTo: range.before ?? Date.now() + 366 * 24 * 60 * 60 * 1000,
  };
}

export function PhoneSalesTab() {
  const [period, setPeriod] = useState<OperationsPeriod>("this_week");
  const [primaryFilter, setPrimaryFilter] =
    useState<PhoneSalesPrimaryFilter>("none");
  const [primaryValue, setPrimaryValue] = useState("all");

  const filterOptions = useQuery(
    api.operations.qualifications.listQualificationFilterOptions,
    {},
  );

  const listArgs = useMemo(() => {
    const range = getOperationsPeriodRange(period);
    return {
      ...buildPhoneSalesPrimaryArgs(primaryFilter, primaryValue),
      scheduledFrom: range.after,
      scheduledTo: range.before,
    };
  }, [period, primaryFilter, primaryValue]);

  const statsArgs = useMemo(
    () => ({
      ...buildPhoneSalesPrimaryArgs(primaryFilter, primaryValue),
      ...getStatsRange(period),
    }),
    [period, primaryFilter, primaryValue],
  );

  const valueOptions = useMemo(
    () => getPhoneSalesValueOptions(primaryFilter, filterOptions),
    [filterOptions, primaryFilter],
  );

  const stats = useQuery(
    api.operations.phoneSales.getPhoneSalesStats,
    statsArgs,
  ) as PhoneSalesStats | undefined;
  const paginated = usePaginatedQuery(
    api.operations.phoneSales.listPhoneSalesMeetings,
    listArgs,
    { initialNumItems: 25 },
  );
  const rows = paginated.results as PhoneSalesRow[];

  return (
    <div className="flex flex-col gap-4">
      <OperationsFilterBar
        period={period}
        onPeriodChange={setPeriod}
        primaryFilter={primaryFilter}
        onPrimaryFilterChange={setPrimaryFilter}
        primaryValue={primaryValue}
        onPrimaryValueChange={setPrimaryValue}
        primaryFilterOptions={PHONE_SALES_PRIMARY_FILTER_OPTIONS}
        valueOptions={valueOptions}
        note="Phone Sales supports one indexed primary dimension with a scheduled date period."
      />

      <Alert>
        <AlertCircleIcon />
        <AlertTitle>Stats are independent from the current page</AlertTitle>
        <AlertDescription>
          The cards use daily meeting rollups for the full selected period. The
          table remains paginated for row-level review.
        </AlertDescription>
      </Alert>

      <PhoneSalesStatCards stats={stats} />

      <PhoneSalesTable
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
