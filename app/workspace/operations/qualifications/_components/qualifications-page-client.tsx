"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { ClockIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
import { TeamGoalDialog } from "@/app/workspace/reports/slack-qualifications/_components/team-goal-dialog";
import { OperationsHealthBanner } from "../../_components/operations-health-banner";
import { OperationsReportExportMenu } from "../../_components/operations-report-export-menu";
import { OperationsReportJobStatus } from "../../_components/report-job-status";
import {
  numberField,
  nullableNumberField,
  OperationsReportSnapshotTable,
  textField,
} from "../../_components/report-snapshot-table";
import {
  useOperationsDashboardReport,
  useOperationsReportRows,
} from "../../_components/use-operations-report-job";
import { QualificationSubmissionsList } from "./qualification-submissions-list";
import { QualifierSchedulesDialog } from "./qualifier-schedules-dialog";
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
      validationOptions: OPERATIONS_DASHBOARD_RANGE_VALIDATION,
    });
  const [goalDialogOpen, setGoalDialogOpen] = useState(false);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const requiresSnapshot = useMemo(
    () => requiresOperationsReportSnapshot(queryRange),
    [queryRange],
  );

  const dashboard = useQuery(
    api.operations.qualificationsDashboard.getQualificationsDashboard,
    requiresSnapshot ? "skip" : { range: queryRange },
  );
  const needsSnapshot = requiresSnapshot || dashboard?.capped === true;
  const snapshot = useOperationsDashboardReport({
    reportKind: "qualifications",
    range: queryRange,
    enabled: needsSnapshot,
  });
  const openerSnapshot = useOperationsReportRows({
    jobId: snapshot.jobId,
    section: "qualification_opener",
    enabled: snapshot.summary !== undefined,
  });
  const displayDashboard = needsSnapshot ? undefined : dashboard;

  const barData = useMemo(
    () =>
      (displayDashboard?.openers ?? []).map((opener) => ({
        key: opener.key,
        label: opener.label,
        value: opener.qualified,
      })),
    [displayDashboard?.openers],
  );

  const goalSublabel = useMemo(() => {
    if (!displayDashboard) {
      return undefined;
    }
    const { dailyQuota, businessDayCount } = displayDashboard.goal;
    if (dailyQuota === null) {
      return rangeLabel;
    }
    return `${formatWholeNumber(dailyQuota)}/day × ${formatWholeNumber(
      businessDayCount,
    )} business day${businessDayCount === 1 ? "" : "s"} — ${rangeLabel}`;
  }, [displayDashboard, rangeLabel]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-[3px] h-7 w-[3px] shrink-0 rounded-full bg-primary/75" />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">
              Qualified Leads
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Opener throughput, team goal attainment, setter contributions,
              and the qualification submissions queue.
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
            <OperationsReportExportMenu
              reportKind="qualifications"
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
          state={snapshot.job?.status ?? (snapshot.requestError ? "failed" : "queued")}
          generatedAt={snapshot.summary?.generatedAt ?? null}
          errorMessage={snapshot.requestError ?? snapshot.job?.failure?.message ?? null}
          onCancel={() => void snapshot.cancel()}
          onRefresh={snapshot.refresh}
          onRetry={snapshot.retry}
        />
      ) : null}

      {!needsSnapshot ? (
        <div className="grid min-w-0 gap-4 lg:grid-cols-3">
          <OpsBarChartCard
            className="min-w-0 lg:col-span-2"
            title="Qualified per Opener"
            description={`Accepted qualification events per opener — ${rangeLabel}`}
            data={barData}
            valueLabel="Qualified"
            loading={displayDashboard === undefined}
            emptyMessage="No qualification events in this range."
          />
          {displayDashboard === undefined ? (
            <GoalRingSkeleton />
          ) : (
            <GoalProgressRing
              goal={displayDashboard.goal.target ?? undefined}
              progress={displayDashboard.goal.progress}
              label="Qualified"
              sublabel={goalSublabel}
              onEdit={() => setGoalDialogOpen(true)}
            />
          )}
        </div>
      ) : snapshot.summary ? (
        <GoalProgressRing
          goal={nullableNumberField(snapshot.summary.payload, "target") ?? undefined}
          progress={numberField(snapshot.summary.payload, "progress")}
          label="Qualified"
          sublabel={rangeLabel}
          onEdit={() => setGoalDialogOpen(true)}
        />
      ) : null}

      {snapshot.summary ? (
        <>
          <OperationsReportSnapshotTable
            title="Historical qualification summary"
            description={`Materialized for ${rangeLabel}.`}
            columns={[
              { key: "totalQualified", label: "Qualified", align: "right" },
              { key: "dailyQuota", label: "Daily quota", align: "right" },
              { key: "target", label: "Target", align: "right" },
              { key: "businessDayCount", label: "Business days", align: "right" },
            ]}
            rows={[{ rowKey: "main", payload: snapshot.summary.payload }]}
          />
          <OperationsReportSnapshotTable
            title="Qualifier contributions"
            description="Completed historical report; use the arrows to page through qualifiers."
            columns={[
              {
                key: "label",
                label: "Qualifier",
                render: (value) => textField({ label: value }, "label"),
              },
              { key: "qualified", label: "Qualified", align: "right" },
              { key: "scheduledHours", label: "Scheduled hours", align: "right" },
              { key: "qualifiedPerHour", label: "Qualified/hour", align: "right" },
            ]}
            rows={openerSnapshot.rows}
            isLoading={openerSnapshot.isLoading}
            hasPreviousPage={openerSnapshot.hasPreviousPage}
            hasNextPage={openerSnapshot.hasNextPage}
            onPreviousPage={openerSnapshot.previousPage}
            onNextPage={openerSnapshot.nextPage}
          />
        </>
      ) : (
        <SetterContributionsTable rows={displayDashboard?.openers} />
      )}

      <QualificationSubmissionsList
        eventWindow={
          snapshot.summary &&
          typeof snapshot.summary.payload.qualifiedAfter === "number" &&
          typeof snapshot.summary.payload.qualifiedBefore === "number"
            ? {
                qualifiedAfter: numberField(snapshot.summary.payload, "qualifiedAfter"),
                qualifiedBefore: numberField(snapshot.summary.payload, "qualifiedBefore"),
              }
            : displayDashboard?.window
        }
      />

      <TeamGoalDialog
        currentGoal={
          snapshot.summary
            ? nullableNumberField(snapshot.summary.payload, "dailyQuota")
            : (displayDashboard?.goal.dailyQuota ?? null)
        }
        open={goalDialogOpen}
        onOpenChange={setGoalDialogOpen}
      />
      <QualifierSchedulesDialog
        open={schedulesOpen}
        onOpenChange={setSchedulesOpen}
      />
    </div>
  );
}
