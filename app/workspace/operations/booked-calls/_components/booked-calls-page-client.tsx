"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { ClockIcon, Settings2Icon } from "lucide-react";
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
import {
  OPERATIONS_DASHBOARD_RANGE_VALIDATION,
  requiresOperationsReportSnapshot,
} from "@/app/workspace/_components/dashboard-date-utils";
import { GoalProgressRing } from "@/app/workspace/_components/goal-progress-ring";
import { OpsBarChartCard } from "@/app/workspace/_components/ops-bar-chart-card";
import { formatWholeNumber } from "@/app/workspace/_components/overview-formatters";
import { useDashboardRange } from "@/app/workspace/_components/use-dashboard-range";
import {
  bookedCallsDashboardFromLive,
  bookedCallsDashboardFromSnapshot,
} from "@/lib/operations-reports/booked-dashboard";
import { OperationsHealthBanner } from "../../_components/operations-health-banner";
import { OperationsReportExportMenu } from "../../_components/operations-report-export-menu";
import { OperationsReportJobStatus } from "../../_components/report-job-status";
import {
  useOperationsDashboardReport,
  useAllOperationsReportRows,
} from "../../_components/use-operations-report-job";
import { BookedCallsDetailsList } from "./booked-calls-details-list";
import { BookingGoalsDialog } from "./booking-goals-dialog";
import { DmCloserContributionsTable } from "./dm-closer-contributions-table";
import { DmCloserSchedulesDialog } from "./dm-closer-schedules-dialog";

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
      validationOptions: OPERATIONS_DASHBOARD_RANGE_VALIDATION,
    });
  const [goalsDialogOpen, setGoalsDialogOpen] = useState(false);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const requiresSnapshot = useMemo(
    () => requiresOperationsReportSnapshot(queryRange),
    [queryRange],
  );

  const dashboard = useQuery(
    api.operations.bookedCallsDashboard.getBookedCallsDashboard,
    requiresSnapshot ? "skip" : { range: queryRange },
  );
  const needsSnapshot = requiresSnapshot || dashboard?.capped === true;
  const snapshot = useOperationsDashboardReport({
    reportKind: "booked-calls",
    range: queryRange,
    enabled: needsSnapshot,
  });
  const closerSnapshot = useAllOperationsReportRows({
    jobId: snapshot.jobId,
    section: "booked_closer",
    enabled: snapshot.summary !== undefined,
  });
  const teamSnapshot = useAllOperationsReportRows({
    jobId: snapshot.jobId,
    section: "booking_team",
    enabled: snapshot.summary !== undefined,
  });
  const snapshotDashboard = useMemo(() => {
    if (
      !needsSnapshot ||
      !snapshot.summary ||
      closerSnapshot.isLoading ||
      closerSnapshot.error ||
      closerSnapshot.rows === undefined ||
      teamSnapshot.isLoading ||
      teamSnapshot.error ||
      teamSnapshot.rows === undefined
    ) {
      return undefined;
    }
    return bookedCallsDashboardFromSnapshot({
      summary: snapshot.summary,
      dmClosers: closerSnapshot.rows,
      teams: teamSnapshot.rows,
    });
  }, [
    closerSnapshot.error,
    closerSnapshot.isLoading,
    closerSnapshot.rows,
    needsSnapshot,
    snapshot.summary,
    teamSnapshot.error,
    teamSnapshot.isLoading,
    teamSnapshot.rows,
  ]);
  const dashboardData = useMemo(() => {
    if (needsSnapshot) return snapshotDashboard?.data ?? undefined;
    return dashboard === undefined ? undefined : bookedCallsDashboardFromLive(dashboard);
  }, [dashboard, needsSnapshot, snapshotDashboard]);
  const snapshotError =
    closerSnapshot.error ?? teamSnapshot.error ?? snapshotDashboard?.error ?? null;

  const barData = useMemo(
    () =>
      (dashboardData?.dmClosers ?? []).map((closer) => ({
        key: closer.key,
        label: closer.label,
        value: closer.booked,
      })),
    [dashboardData?.dmClosers],
  );

  const dmCloserOptions = useMemo(
    () =>
      dashboardData?.dmClosers.map((closer) => ({
        key: closer.key,
        label: closer.label,
      })),
    [dashboardData?.dmClosers],
  );

  const goalSublabel = useMemo(() => {
    if (!dashboardData) {
      return undefined;
    }
    const { businessDayCount, teams } = dashboardData.goal;
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
  }, [dashboardData, rangeLabel]);

  const goalBreakdown = useMemo(
    () =>
      dashboardData?.goal.teams
        .filter((team) => team.target !== null || team.progress > 0)
        .map((team) => ({
          label: team.label,
          goal: team.target ?? 0,
          progress: team.progress,
        })),
    [dashboardData?.goal.teams],
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
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSchedulesOpen(true)}
            >
              <ClockIcon data-icon="inline-start" aria-hidden="true" />
              Schedules
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" asChild>
                  <Link href="/workspace/operations/booked-calls/attribution">
                    <Settings2Icon data-icon="inline-start" aria-hidden="true" />
                    Configuration
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-pretty" side="bottom">
                DM teams, booking goals, closers, and hourly contract rates.
              </TooltipContent>
            </Tooltip>
            <OperationsReportExportMenu
              reportKind="booked-calls"
              range={queryRange}
            />
          </div>
          <DashboardDateRangeFilter
            validationOptions={OPERATIONS_DASHBOARD_RANGE_VALIDATION}
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

      {needsSnapshot ? (
        <OperationsReportJobStatus
          state={snapshotError ? "failed" : snapshot.job?.status ?? (snapshot.requestError ? "failed" : "queued")}
          generatedAt={snapshot.summary?.generatedAt ?? null}
          errorMessage={snapshotError ?? snapshot.requestError ?? snapshot.job?.failure?.message ?? null}
          onCancel={() => void snapshot.cancel()}
          onRefresh={snapshot.refresh}
          onRetry={snapshot.retry}
        />
      ) : null}

      <div className="grid min-w-0 gap-4 lg:grid-cols-3">
        <OpsBarChartCard
          className="min-w-0 lg:col-span-2"
          title="Booked per DM Closer"
          description={`Booked calls attributed per DM closer — ${rangeLabel}`}
          data={barData}
          valueLabel="Booked"
          loading={dashboardData === undefined}
          emptyMessage="No booked calls in this range."
        />
        {dashboardData === undefined ? (
          <GoalRingSkeleton />
        ) : (
          <GoalProgressRing
            goal={dashboardData.goal.totalTarget ?? undefined}
            progress={dashboardData.goal.progress}
            label="Booked"
            sublabel={goalSublabel}
            breakdown={goalBreakdown}
            onEdit={() => setGoalsDialogOpen(true)}
          />
        )}
      </div>

      <DmCloserContributionsTable rows={dashboardData?.dmClosers} />

      <BookedCallsDetailsList
        window={
          dashboardData?.window
        }
        dmCloserOptions={dmCloserOptions}
      />

      <BookingGoalsDialog
        open={goalsDialogOpen}
        onOpenChange={setGoalsDialogOpen}
      />
      <DmCloserSchedulesDialog
        open={schedulesOpen}
        onOpenChange={setSchedulesOpen}
      />
    </div>
  );
}
