"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { ArrowUpRightIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { mergeBookedCallsDashboard } from "@/convex/analytics/merge/operations";
import { dashboardRangeFromToday, dashboardRangePlan } from "@/lib/analyticsRange";
import { businessDateForInstant, businessDayDisclosure } from "@/lib/businessDay";
import {
  bookedCallsDashboardFromLive,
  bookedCallsDashboardFromSnapshot,
  type BookedCallsDashboardViewModel,
} from "@/lib/operations-reports/booked-dashboard";
import {
  AnalyticsFreshnessAlert,
  FreshnessWords,
  freshnessSummary,
} from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport, useAnalyticsSource } from "@/app/workspace/_components/analytics/use-analytics-report";
import {
  OPERATIONS_DASHBOARD_RANGE_VALIDATION,
  requiresOperationsReportSnapshot,
} from "@/app/workspace/_components/dashboard-date-utils";
import {
  DateRangePicker,
  formatBusinessDateSpan,
  rangePhrase as phraseForRange,
  type DashboardRangeInput,
} from "@/app/workspace/_components/date-range-picker";
import { PageBand } from "@/app/workspace/_components/page-band";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { useDashboardRange } from "@/app/workspace/_components/use-dashboard-range";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { cn } from "@/lib/utils";
import { OperationsHealthBanner } from "../../_components/operations-health-banner";
import { OperationsReportExportMenu } from "../../_components/operations-report-export-menu";
import { OperationsReportJobStatus } from "../../_components/report-job-status";
import { useAllOperationsReportRows, useOperationsDashboardReport } from "../../_components/use-operations-report-job";
import { MovedToTeamChip, TipLink, teamHref } from "../../_components/team-links";
import { bookingTeams } from "./booking-teams";
import { BookedCallsDetailsList } from "./booked-calls-details-list";
import { DmClosersByTeam, DmClosersByTeamSkeleton } from "./dm-closers-by-team";
import { TeamGoalsCard, TeamGoalsSkeletonRows } from "./team-goals-card";

const PRESET_WORDS = { today: "Today", this_week: "This week", this_month: "This month" } as const;

/** "This week · Oct 26 – Nov 1", "Today · Nov 2", or a custom range's dates. */
function rangeWords(
  range: DashboardRangeInput,
  window: BookedCallsDashboardViewModel["window"] | undefined,
  setting: Parameters<typeof businessDateForInstant>[1],
  today: string,
) {
  const dates = window
    ? formatBusinessDateSpan(
        businessDateForInstant(window.start, setting),
        businessDateForInstant(window.end - 1, setting),
        today,
      )
    : null;
  if (range.kind === "custom") return dates ?? "Custom range";
  return dates ? `${PRESET_WORDS[range.preset]} · ${dates}` : PRESET_WORDS[range.preset];
}

/** A plain link on the band: board text, underlined on hover. */
const boardLink =
  "inline-flex h-7 items-center gap-0.5 px-1 text-[13px] text-board-muted hover:text-board-foreground hover:underline underline-offset-[3px] focus-visible:ring-offset-board";

export function BookedCallsPageClient() {
  usePageTitle("Booked Calls");
  const { setting } = useBusinessDay();
  const now = useNow();
  const { range, setRange, queryRange, validationMessage } = useDashboardRange({
    urlSync: true,
    defaultRange: { kind: "preset", preset: "today" },
    validationOptions: OPERATIONS_DASHBOARD_RANGE_VALIDATION,
  });
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
  const source = useAnalyticsSource("booked_calls", plan);
  const report = useAnalyticsReport({
    page: "booked_calls",
    reportId: "booked_calls.dashboard",
    plan,
    live: api.operations.bookedCallsDashboard.getBookedCallsDashboard,
    merge: mergeBookedCallsDashboard,
    todayArgs: { range: dashboardRangeFromToday(queryRange, todayBusinessDate) },
    liveArgs: source !== "warehouse" && requiresSnapshot ? "skip" : { range: queryRange },
  });
  const dashboard = report.data;
  const needsSnapshot = source === "live" && (requiresSnapshot || dashboard?.capped === true);
  const snapshot = useOperationsDashboardReport({ reportKind: "booked-calls", range: queryRange, enabled: needsSnapshot });
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
  const fresh = useMemo(() => {
    if (needsSnapshot) return snapshotDashboard?.data ?? undefined;
    return dashboard === undefined ? undefined : bookedCallsDashboardFromLive(dashboard);
  }, [dashboard, needsSnapshot, snapshotDashboard]);
  const snapshotError = closerSnapshot.error ?? teamSnapshot.error ?? snapshotDashboard?.error ?? null;

  // A new range keeps the last one's numbers on screen, dimmed, until it
  // arrives (DESIGN.md, Kept Data While Reloading). The kept numbers keep
  // their own range, so their words still match them.
  const [kept, setKept] = useState(fresh && { data: fresh, range: queryRange });
  if (fresh !== undefined && fresh !== kept?.data) setKept({ data: fresh, range: queryRange });
  const data = fresh ?? kept?.data;
  const reloading = fresh === undefined && kept !== undefined;
  const shownRange = fresh === undefined && kept ? kept.range : queryRange;
  const phrase = phraseForRange(shownRange);

  // Team names to ids, only to link a team with no goal row to its page.
  const teamList = useQuery(api.leadGen.workers.listTeams, { includeInactive: true });
  const teamIdByLabel = useMemo(
    () => new Map((teamList ?? []).map((team) => [team.name, team._id as string])),
    [teamList],
  );
  const teams = useMemo(
    () => (data ? bookingTeams(data, now < data.window.end, teamIdByLabel) : undefined),
    [data, now, teamIdByLabel],
  );
  const dmCloserOptions = useMemo(
    () => data?.dmClosers.map((closer) => ({ key: closer.key, label: closer.label })),
    [data?.dmClosers],
  );

  const freshness = freshnessSummary([report.freshness], now);

  return (
    <div className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3">
      <PageBand
        title="Booked Calls"
        description={
          <>
            <span className="font-medium text-board-foreground">
              {rangeWords(shownRange, data?.window, setting, todayBusinessDate)}
            </span>
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
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <OperationsReportExportMenu reportKind="booked-calls" range={queryRange} />
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
        <div className="-mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-board-line px-4 py-1.5 @lg:-mx-[18px] @lg:px-[18px]">
          <TipLink
            href="/workspace/booking"
            tip="Booking setup › Coverage: which links and event types each team's DM closers get."
            className={boardLink}
          >
            Coverage
            <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
          </TipLink>
          <MovedToTeamChip
            href={teamHref.teams()}
            moved={["Schedules", "Edit goals", "DM teams & links"]}
            tip="DM teams, their closers' weeks and their goals now live in Team. Change them there; this page follows."
          />
        </div>
        {validationMessage ? (
          <p role="alert" className="pt-2 pb-3.5 text-[13px] text-board-danger @lg:pb-4">
            {validationMessage}
          </p>
        ) : null}
      </PageBand>

      {needsSnapshot ? null : <AnalyticsFreshnessAlert summary={freshness} />}
      <OperationsHealthBanner />
      {needsSnapshot ? (
        <OperationsReportJobStatus
          state={snapshotError ? "failed" : (snapshot.job?.status ?? (snapshot.requestError ? "failed" : "queued"))}
          generatedAt={snapshot.summary?.generatedAt ?? null}
          errorMessage={snapshotError ?? snapshot.requestError ?? snapshot.job?.failure?.message ?? null}
          onCancel={() => void snapshot.cancel()}
          onRefresh={snapshot.refresh}
          onRetry={snapshot.retry}
        />
      ) : null}

      <div
        aria-busy={reloading || data === undefined}
        className={cn("flex min-w-0 flex-col gap-3.5 transition-opacity duration-200 short:gap-3", reloading && "opacity-60")}
      >
        {teams ? (
          <TeamGoalsCard teams={teams} rangePhrase={phrase} />
        ) : (
          <DetailCard title="Team goals" className="min-w-0">
            <TeamGoalsSkeletonRows />
          </DetailCard>
        )}
        <div className="grid min-w-0 items-start gap-3.5 @5xl:grid-cols-[1.2fr_1fr] short:gap-3">
          {teams ? <DmClosersByTeam teams={teams} rangePhrase={phrase} /> : <DmClosersByTeamSkeleton />}
          <BookedCallsDetailsList window={data?.window} dmCloserOptions={dmCloserOptions} rangePhrase={phrase} />
        </div>
      </div>
    </div>
  );
}
