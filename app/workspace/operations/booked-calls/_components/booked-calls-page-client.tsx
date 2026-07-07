"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { Settings2Icon, TriangleAlertIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePageTitle } from "@/hooks/use-page-title";
import { DashboardDateRangeFilter } from "@/app/workspace/_components/dashboard-date-range-filter";
import { GoalProgressRing } from "@/app/workspace/_components/goal-progress-ring";
import { OpsBarChartCard } from "@/app/workspace/_components/ops-bar-chart-card";
import { formatWholeNumber } from "@/app/workspace/_components/overview-formatters";
import { useDashboardRange } from "@/app/workspace/_components/use-dashboard-range";
import { OperationsHealthBanner } from "../../_components/operations-health-banner";
import { BookedCallsConfigSheet } from "./booked-calls-config-sheet";
import { BookedCallsDetailsList } from "./booked-calls-details-list";
import { BookingGoalsDialog } from "./booking-goals-dialog";
import { DmCloserContributionsTable } from "./dm-closer-contributions-table";

function GoalRingSkeleton() {
  return (
    <Card role="status" aria-label="Loading goal progress">
      <CardHeader className="gap-2">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-44 max-w-full" />
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-3">
        <Skeleton className="aspect-square w-full max-w-[220px] rounded-full" />
        <Skeleton className="h-4 w-32" />
      </CardContent>
    </Card>
  );
}

export function BookedCallsPageClient() {
  usePageTitle("Booked Calls");

  const { range, setRange, queryRange, rangeLabel, validationMessage } =
    useDashboardRange({
      urlSync: true,
      defaultRange: { kind: "preset", preset: "this_week" },
    });
  const [goalsDialogOpen, setGoalsDialogOpen] = useState(false);
  const [configSheetOpen, setConfigSheetOpen] = useState(false);

  const dashboard = useQuery(
    api.operations.bookedCallsDashboard.getBookedCallsDashboard,
    { range: queryRange },
  );

  const barData = useMemo(
    () =>
      (dashboard?.dmClosers ?? []).map((closer) => ({
        key: closer.key,
        label: closer.label,
        value: closer.booked,
      })),
    [dashboard?.dmClosers],
  );

  const dmCloserOptions = useMemo(
    () =>
      dashboard?.dmClosers.map((closer) => ({
        key: closer.key,
        label: closer.label,
      })),
    [dashboard?.dmClosers],
  );

  const goalSublabel = useMemo(() => {
    if (!dashboard) {
      return undefined;
    }
    const { businessDayCount, teams } = dashboard.goal;
    const teamsWithQuota = teams.filter((team) => team.dailyQuota !== null);
    if (teamsWithQuota.length === 0) {
      return rangeLabel;
    }
    const totalDaily = teamsWithQuota.reduce(
      (sum, team) => sum + (team.dailyQuota ?? 0),
      0,
    );
    return `${formatWholeNumber(totalDaily)}/day across ${formatWholeNumber(
      teamsWithQuota.length,
    )} team${teamsWithQuota.length === 1 ? "" : "s"} × ${formatWholeNumber(
      businessDayCount,
    )} business day${businessDayCount === 1 ? "" : "s"} — ${rangeLabel}`;
  }, [dashboard, rangeLabel]);

  const goalBreakdown = useMemo(
    () =>
      dashboard?.goal.teams
        .filter((team) => team.target !== null || team.progress > 0)
        .map((team) => ({
          label: team.label,
          goal: team.target ?? 0,
          progress: team.progress,
        })),
    [dashboard?.goal.teams],
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-[3px] h-7 w-[3px] shrink-0 rounded-full bg-primary/75" />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">
              Booked Calls
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              DM Closer Operations — booked-call throughput, team booking
              goals, closer contributions, and booking details.
            </p>
          </div>
        </div>
        <div className="flex flex-col items-start gap-3 lg:items-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfigSheetOpen(true)}
              >
                <Settings2Icon data-icon="inline-start" aria-hidden="true" />
                Configuration
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-pretty" side="bottom">
              DM teams, booking goals, closers, and hourly contract rates.
            </TooltipContent>
          </Tooltip>
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

      <div className="grid min-w-0 gap-4 lg:grid-cols-3">
        <OpsBarChartCard
          className="min-w-0 lg:col-span-2"
          title="Booked per DM Closer"
          description={`Booked calls attributed per DM closer — ${rangeLabel}`}
          data={barData}
          valueLabel="Booked"
          loading={dashboard === undefined}
          emptyMessage="No booked calls in this range."
        />
        {dashboard === undefined ? (
          <GoalRingSkeleton />
        ) : (
          <GoalProgressRing
            goal={dashboard.goal.totalTarget ?? undefined}
            progress={dashboard.goal.progress}
            label="Booked"
            sublabel={goalSublabel}
            breakdown={goalBreakdown}
            onEdit={() => setGoalsDialogOpen(true)}
          />
        )}
      </div>

      <DmCloserContributionsTable rows={dashboard?.dmClosers} />

      <BookedCallsDetailsList
        window={dashboard?.window}
        dmCloserOptions={dmCloserOptions}
      />

      <BookingGoalsDialog
        open={goalsDialogOpen}
        onOpenChange={setGoalsDialogOpen}
      />
      <BookedCallsConfigSheet
        open={configSheetOpen}
        onOpenChange={setConfigSheetOpen}
      />
    </div>
  );
}
