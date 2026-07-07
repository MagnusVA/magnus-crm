"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { TriangleAlertIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageTitle } from "@/hooks/use-page-title";
import { DashboardDateRangeFilter } from "@/app/workspace/_components/dashboard-date-range-filter";
import { GoalProgressRing } from "@/app/workspace/_components/goal-progress-ring";
import { OpsBarChartCard } from "@/app/workspace/_components/ops-bar-chart-card";
import { formatWholeNumber } from "@/app/workspace/_components/overview-formatters";
import { useDashboardRange } from "@/app/workspace/_components/use-dashboard-range";
import { TeamGoalDialog } from "@/app/workspace/reports/slack-qualifications/_components/team-goal-dialog";
import { OperationsHealthBanner } from "../../_components/operations-health-banner";
import { QualificationSubmissionsList } from "./qualification-submissions-list";
import { SetterContributionsTable } from "./setter-contributions-table";

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

export function QualificationsPageClient() {
  usePageTitle("Qualified Leads");

  const { range, setRange, queryRange, rangeLabel, validationMessage } =
    useDashboardRange({
      urlSync: true,
      defaultRange: { kind: "preset", preset: "this_week" },
    });
  const [goalDialogOpen, setGoalDialogOpen] = useState(false);

  const dashboard = useQuery(
    api.operations.qualificationsDashboard.getQualificationsDashboard,
    { range: queryRange },
  );

  const barData = useMemo(
    () =>
      (dashboard?.openers ?? []).map((opener) => ({
        key: opener.key,
        label: opener.label,
        value: opener.qualified,
      })),
    [dashboard?.openers],
  );

  const goalSublabel = useMemo(() => {
    if (!dashboard) {
      return undefined;
    }
    const { dailyQuota, businessDayCount } = dashboard.goal;
    if (dailyQuota === null) {
      return rangeLabel;
    }
    return `${formatWholeNumber(dailyQuota)}/day × ${formatWholeNumber(
      businessDayCount,
    )} business day${businessDayCount === 1 ? "" : "s"} — ${rangeLabel}`;
  }, [dashboard, rangeLabel]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="sticky top-0 z-20 -mx-6 -mt-6 border-b bg-background/95 px-6 py-3 backdrop-blur supports-backdrop-filter:bg-background/80">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-normal text-pretty">
            Qualified Leads
          </h1>
          <p className="max-w-3xl text-xs text-muted-foreground">
            Opener throughput, team goal attainment, setter contributions, and
            the qualification submissions queue.
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

      <div className="grid min-w-0 gap-4 lg:grid-cols-3">
        <OpsBarChartCard
          className="min-w-0 lg:col-span-2"
          title="Qualified per Opener"
          description={`Accepted qualification events per opener — ${rangeLabel}`}
          data={barData}
          valueLabel="Qualified"
          loading={dashboard === undefined}
          emptyMessage="No qualification events in this range."
        />
        {dashboard === undefined ? (
          <GoalRingSkeleton />
        ) : (
          <GoalProgressRing
            goal={dashboard.goal.target ?? undefined}
            progress={dashboard.goal.progress}
            label="Qualified"
            sublabel={goalSublabel}
            onEdit={() => setGoalDialogOpen(true)}
          />
        )}
      </div>

      <SetterContributionsTable rows={dashboard?.openers} />

      <QualificationSubmissionsList eventWindow={dashboard?.window} />

      <TeamGoalDialog
        currentGoal={dashboard?.goal.dailyQuota ?? null}
        open={goalDialogOpen}
        onOpenChange={setGoalDialogOpen}
      />
    </div>
  );
}
