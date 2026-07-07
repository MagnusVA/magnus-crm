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
      <header className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-[3px] h-7 w-[3px] shrink-0 rounded-full bg-primary/75" />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">
              Phone Sales Ops
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Sales-call throughput, cash collected, per-program performance,
              and the phone-closer meeting queue.
            </p>
          </div>
        </div>
        <div className="flex flex-col items-start gap-3 lg:items-end">
          <DashboardDateRangeFilter
            validationMessage={validationMessage}
            value={range}
            onChange={setRange}
          />
          <p className="text-xs text-muted-foreground">
            Showing: {rangeLabel}
          </p>
        </div>
      </header>

      <OperationsHealthBanner />

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
