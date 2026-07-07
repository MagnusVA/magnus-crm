"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { TriangleAlertIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { DashboardDateRangeFilter } from "@/app/workspace/_components/dashboard-date-range-filter";
import { useDashboardRange } from "@/app/workspace/_components/use-dashboard-range";
import { OperationsHealthBanner } from "../../_components/operations-health-banner";
import { PerProgramStatCard } from "./per-program-stat-card";
import { PhoneCloserTable } from "./phone-closer-table";
import { SalesCallsDetailsList } from "./sales-calls-details-list";
import { SalesCallsStatCards } from "./sales-calls-stat-cards";

export function SalesCallsPageClient() {
  usePageTitle("Phone Sales Ops");

  const { range, setRange, queryRange, rangeLabel, validationMessage } =
    useDashboardRange({
      urlSync: true,
      defaultRange: { kind: "preset", preset: "this_week" },
    });

  const dashboard = useQuery(
    api.operations.salesCallsDashboard.getSalesCallsDashboard,
    { range: queryRange },
  );

  const closerOptions = useMemo(
    () =>
      dashboard?.closers.map((closer) => ({
        key: closer.closerId,
        label: closer.label,
      })),
    [dashboard?.closers],
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="sticky top-0 z-20 -mx-6 -mt-6 border-b bg-background/95 px-6 py-3 backdrop-blur supports-backdrop-filter:bg-background/80">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-normal text-pretty">
            Phone Sales Ops
          </h1>
          <p className="max-w-3xl text-xs text-muted-foreground">
            Sales-call throughput, cash collected, per-program performance, and
            the phone-closer meeting queue.
          </p>
        </div>
      </div>

      <OperationsHealthBanner />

      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <p className="text-xs text-muted-foreground">Showing: {rangeLabel}</p>
        <DashboardDateRangeFilter
          validationMessage={validationMessage}
          value={range}
          onChange={setRange}
        />
      </div>

      {dashboard?.capped ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <TriangleAlertIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-amber-500"
          />
          This range hit the event sample cap, so totals reflect the loaded
          sample only. Narrow the range for exact counts.
        </p>
      ) : null}

      <SalesCallsStatCards stats={dashboard?.stats} />

      <PerProgramStatCard data={dashboard?.perProgram} rangeLabel={rangeLabel} />

      <PhoneCloserTable
        rows={dashboard?.closers}
        teamTotal={dashboard?.teamTotal}
      />

      <SalesCallsDetailsList
        window={dashboard?.window}
        closerOptions={closerOptions}
      />
    </div>
  );
}
