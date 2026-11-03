"use client";

import { useMemo, useState } from "react";
import { ClockIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { mergeQualificationsDashboard } from "@/convex/analytics/merge/operations";
import { dashboardRangeFromToday, dashboardRangePlan } from "@/lib/analyticsRange";
import { businessDateForInstant, businessDayDisclosure } from "@/lib/businessDay";
import { cn } from "@/lib/utils";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  AnalyticsFreshnessAlert,
  FreshnessWords,
  freshnessSummary,
} from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport, useAnalyticsSource } from "@/app/workspace/_components/analytics/use-analytics-report";
import {
  OPERATIONS_DASHBOARD_RANGE_VALIDATION,
  dashboardRangeToDayKeys,
  requiresOperationsReportSnapshot,
} from "@/app/workspace/_components/dashboard-date-utils";
import {
  DateRangePicker,
  formatBusinessDateSpan,
  rangePhrase,
  type DashboardRangeInput,
} from "@/app/workspace/_components/date-range-picker";
import { PageBand } from "@/app/workspace/_components/page-band";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { useDashboardRange } from "@/app/workspace/_components/use-dashboard-range";
import { SectionError } from "@/app/workspace/closer/_components/section-state";
import { TeamGoalDialog } from "@/app/workspace/reports/slack-qualifications/_components/team-goal-dialog";
import {
  qualificationDashboardFromLive,
  qualificationDashboardFromSnapshot,
  type QualificationDashboardViewModel,
} from "@/lib/operations-reports/qualification-dashboard";
import { OperationsHealthBanner } from "../../_components/operations-health-banner";
import { OperationsReportExportMenu } from "../../_components/operations-report-export-menu";
import { OperationsReportJobStatus } from "../../_components/report-job-status";
import { useAllOperationsReportRows, useOperationsDashboardReport } from "../../_components/use-operations-report-job";
import { BAND_BUTTON_CLASS, QualificationsGoalRow } from "./qualifications-goal-row";
import { QualifierSchedulesDialog } from "./qualifier-schedules-dialog";
import { SettersPane } from "./setters-pane";
import { SubmissionsPane, type StageFilter } from "./submissions-pane";

const PRESET_WORDS = { today: "Today", this_week: "This week", this_month: "This month" } as const;

/** "Today · Nov 2", "This week · Oct 27 – Nov 2", or a custom range's dates. */
function rangeWords(range: DashboardRangeInput, now: number, setting: ReturnType<typeof useBusinessDay>["setting"]) {
  const today = businessDateForInstant(now, setting);
  const { startDayKey, endDayKey } = dashboardRangeToDayKeys(range, now, setting);
  const dates = formatBusinessDateSpan(startDayKey, endDayKey, today);
  return range.kind === "custom" ? dates : `${PRESET_WORDS[range.preset]} · ${dates}`;
}

export function QualificationsPageClient() {
  usePageTitle("Qualified Leads");
  const { setting } = useBusinessDay();
  const now = useNow();
  const { range, setRange, queryRange } = useDashboardRange({
    urlSync: true,
    defaultRange: { kind: "preset", preset: "today" },
    validationOptions: OPERATIONS_DASHBOARD_RANGE_VALIDATION,
  });
  const [goalDialogOpen, setGoalDialogOpen] = useState(false);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  // The submissions query takes one primary filter, so a setter and a stage
  // never apply together: choosing one clears the other.
  const [setter, setSetter] = useState<{ key: string; label: string } | null>(null);
  const [stage, setStage] = useState<StageFilter>("all");

  const requiresSnapshot = useMemo(
    () => requiresOperationsReportSnapshot(queryRange, setting, now),
    [queryRange, now, setting],
  );

  // Today reads Convex live, and so does today's part of a longer range; the
  // days before today read ClickHouse once the page is switched, and then
  // need no snapshot job. Until then ranges over 7 days use the snapshot
  // (docs/agents/reporting.md).
  const todayBusinessDate = businessDateForInstant(now, setting);
  const plan = dashboardRangePlan(queryRange, todayBusinessDate);
  const source = useAnalyticsSource("qualifications", plan);
  const report = useAnalyticsReport({
    page: "qualifications",
    reportId: "qualifications.dashboard",
    plan,
    live: api.operations.qualificationsDashboard.getQualificationsDashboard,
    merge: mergeQualificationsDashboard,
    todayArgs: { range: dashboardRangeFromToday(queryRange, todayBusinessDate) },
    liveArgs: source !== "warehouse" && requiresSnapshot ? "skip" : { range: queryRange },
  });
  const dashboard = report.data;
  const needsSnapshot = source === "live" && (requiresSnapshot || dashboard?.capped === true);
  const snapshot = useOperationsDashboardReport({
    reportKind: "qualifications",
    range: queryRange,
    enabled: needsSnapshot,
  });
  const openerSnapshot = useAllOperationsReportRows({
    jobId: snapshot.jobId,
    section: "qualification_opener",
    enabled: snapshot.summary !== undefined,
  });
  const snapshotDashboard = useMemo(() => {
    if (
      !needsSnapshot ||
      !snapshot.summary ||
      openerSnapshot.isLoading ||
      openerSnapshot.error ||
      openerSnapshot.rows === undefined
    ) {
      return undefined;
    }
    return qualificationDashboardFromSnapshot({ summary: snapshot.summary, openers: openerSnapshot.rows });
  }, [needsSnapshot, openerSnapshot.error, openerSnapshot.isLoading, openerSnapshot.rows, snapshot.summary]);
  const displayDashboard = useMemo(() => {
    if (needsSnapshot) return snapshotDashboard?.data ?? undefined;
    return dashboard === undefined ? undefined : qualificationDashboardFromLive(dashboard);
  }, [dashboard, needsSnapshot, snapshotDashboard]);
  const snapshotError = openerSnapshot.error ?? snapshotDashboard?.error ?? null;

  const freshness = freshnessSummary([report.freshness], now);

  // A new range keeps the last one's numbers on screen, dimmed, until it
  // arrives (DESIGN.md, Kept Data While Reloading). A snapshot job or a
  // failed read says so in its alert instead.
  // Kept by content, not identity, so a source that hands back equal data as
  // new objects can't re-set this on every render.
  const displaySignature = useMemo(
    () => (displayDashboard === undefined ? undefined : JSON.stringify([queryRange, displayDashboard])),
    [displayDashboard, queryRange],
  );
  const [kept, setKept] = useState<{
    signature: string;
    data: QualificationDashboardViewModel;
    range: DashboardRangeInput;
  } | null>(null);
  if (displayDashboard !== undefined && displaySignature !== undefined && displaySignature !== kept?.signature) {
    setKept({ signature: displaySignature, data: displayDashboard, range: queryRange });
  }
  const canKeep = !needsSnapshot && freshness.kind !== "failed";
  const shown = displayDashboard ?? (canKeep ? kept?.data : undefined);
  const reloading = displayDashboard === undefined && shown !== undefined;
  const shownRange = displayDashboard === undefined && shown && kept ? kept.range : queryRange;

  // A failed read with nothing kept leaves the panes nothing to show; they
  // say so instead of loading forever under the failure notice.
  const failed =
    shown === undefined &&
    (needsSnapshot
      ? snapshotError !== null || snapshot.requestError !== null || snapshot.job?.status === "failed"
      : freshness.kind === "failed");

  const setters = shown?.openers;
  const selectedSetter = setter && setters?.find((entry) => entry.key === setter.key);
  // A setter the new range doesn't list at all stops filtering; one listed
  // with no leads stays pressed and shows its zero.
  if (setter && displayDashboard !== undefined && !displayDashboard.openers.some((entry) => entry.key === setter.key)) {
    setSetter(null);
  }

  return (
    <div className="@container mx-auto flex w-full max-w-[1500px] flex-col gap-3.5 pb-6 short:gap-3">
      <PageBand
        title="Qualified Leads"
        description={
          <>
            <span className="font-medium text-board-foreground">{rangeWords(shownRange, now, setting)}</span>
            {!needsSnapshot && freshness.kind === "line" ? (
              <>
                {" · "}
                <FreshnessWords summary={freshness} />
              </>
            ) : null}
            <span className="hidden @3xl:inline"> · {businessDayDisclosure(setting)}</span>
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" className={BAND_BUTTON_CLASS} onClick={() => setSchedulesOpen(true)}>
              <ClockIcon data-icon="inline-start" aria-hidden="true" />
              Schedules
            </Button>
            {/* The shared export menu draws a small outline button; the band sets it in its board tone. */}
            <div className="contents [&>button]:h-[34px] [&>button]:rounded-[7px] [&>button]:border-board-foreground/15 [&>button]:bg-board-raised [&>button]:px-3 [&>button]:text-[13px] [&>button]:text-board-foreground [&>button:hover]:bg-board-foreground/10 [&>button:hover]:text-board-foreground">
              <OperationsReportExportMenu reportKind="qualifications" range={queryRange} />
            </div>
            <DateRangePicker
              tone="board"
              value={range}
              todayBusinessDate={todayBusinessDate}
              validationOptions={OPERATIONS_DASHBOARD_RANGE_VALIDATION}
              onChange={setRange}
            />
          </div>
        }
      >
        <QualificationsGoalRow
          goal={shown?.goal}
          reloading={reloading}
          failed={failed}
          setters={setters}
          selectedSetter={setter?.key ?? null}
          onEditGoal={() => setGoalDialogOpen(true)}
        />
      </PageBand>

      {needsSnapshot ? (
        <OperationsReportJobStatus
          state={snapshotError ? "failed" : (snapshot.job?.status ?? (snapshot.requestError ? "failed" : "queued"))}
          generatedAt={snapshot.summary?.generatedAt ?? null}
          errorMessage={snapshotError ?? snapshot.requestError ?? snapshot.job?.failure?.message ?? null}
          onCancel={() => void snapshot.cancel()}
          onRefresh={snapshot.refresh}
          onRetry={snapshot.retry}
        />
      ) : (
        <AnalyticsFreshnessAlert summary={freshness} />
      )}

      <OperationsHealthBanner />

      <Card className="min-w-0 gap-0 overflow-hidden py-0 @4xl:grid @4xl:h-[clamp(30rem,calc(100dvh-18rem),60rem)] @4xl:grid-cols-[minmax(16rem,22.5rem)_minmax(0,1fr)]">
        <section aria-labelledby="qualifications-setters" className="flex min-h-0 flex-col border-b @4xl:border-r @4xl:border-b-0">
          <div className="flex min-h-11 flex-wrap items-center gap-x-2 border-b px-4 py-2">
            <h2 id="qualifications-setters" className="text-[0.9375rem] font-semibold">
              Setters
            </h2>
            <span className="ml-auto text-[13px] text-muted-foreground">Qualified · per scheduled hour</span>
          </div>
          <div
            aria-busy={reloading}
            className={cn(
              "max-h-[22rem] min-h-0 flex-1 overflow-y-auto overscroll-contain transition-opacity duration-200 motion-reduce:transition-none @4xl:max-h-none",
              reloading && "opacity-60",
            )}
          >
            <SettersPane
              setters={setters}
              failed={failed}
              total={shown?.goal.progress}
              selected={setter?.key ?? null}
              onSelect={(key) => {
                const next = key === null ? null : setters?.find((entry) => entry.key === key);
                setSetter(next ? { key: next.key, label: next.label } : null);
                if (next) setStage("all");
              }}
            />
          </div>
        </section>
        <section aria-label="Submissions" className="flex min-h-0 min-w-0 flex-col">
          <SectionErrorBoundary sectionName="qualification submissions" fallback={<SectionError what="the submissions" />}>
            <SubmissionsPane
              eventWindow={displayDashboard?.window}
              failed={failed}
              setter={setter ? { key: setter.key, label: selectedSetter?.label ?? setter.label } : null}
              stage={stage}
              onStageChange={(next) => {
                setStage(next);
                if (next !== "all") setSetter(null);
              }}
              onClearSetter={() => setSetter(null)}
              rangePhrase={rangePhrase(shownRange)}
              qualified={setter ? selectedSetter?.qualified : shown?.goal.progress}
            />
          </SectionErrorBoundary>
        </section>
      </Card>

      <TeamGoalDialog currentGoal={shown?.goal.dailyQuota ?? null} open={goalDialogOpen} onOpenChange={setGoalDialogOpen} />
      <QualifierSchedulesDialog open={schedulesOpen} onOpenChange={setSchedulesOpen} />
    </div>
  );
}
