"use client";

import { useEffect, useState } from "react";
import posthog from "@/lib/posthog-browser";
import { api } from "@/convex/_generated/api";
import { mergeOverviewDashboard } from "@/convex/analytics/merge/overview";
import { dashboardRangeFromToday, dashboardRangePlan } from "@/lib/analyticsRange";
import { businessDateForInstant, businessDayDisclosure } from "@/lib/businessDay";
import {
  AnalyticsFreshnessAlert,
  FreshnessWords,
  freshnessSummary,
} from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { useRole } from "@/components/auth/role-context";
import { cn } from "@/lib/utils";
import { validateCustomDashboardRange } from "./dashboard-date-utils";
import { DateRangePicker, formatBusinessDateSpan, rangePhrase, type DashboardRangeInput } from "./date-range-picker";
import type { OverviewDashboard } from "./overview-dashboard-types";
import { DmClosersRanking, LeadGenRanking, QualifiersRanking } from "./overview-rankings";
import { PageBand } from "./page-band";
import { PhoneCloserOperationsSection } from "./phone-closer-operations-section";
import { OverviewDashboardSkeleton, OverviewSectionsSkeleton } from "./skeletons/overview-dashboard-skeleton";
import { TopOriginsOverviewSection } from "./top-origins-overview-section";

type OverviewSectionKey = Exclude<keyof OverviewDashboard, "range">;

/**
 * Reports a section the backend marked `status: "error"`. The query returns
 * the failure instead of reporting it, because it re-runs on every update;
 * this reports once per mount for each section and error code.
 */
function useReportOverviewSectionError(
  key: OverviewSectionKey,
  section: OverviewDashboard[OverviewSectionKey] | undefined,
) {
  const errorCode = section?.status === "error" ? section.errorCode : null;
  useEffect(() => {
    if (errorCode === null) return;
    posthog.captureException(new Error(`Overview section failed: ${key}`), {
      error_origin: "dashboard_overview",
      section: key,
      error_code: errorCode,
    });
  }, [key, errorCode]);
}

const PRESET_WORDS = { today: "Today", this_week: "This week", this_month: "This month" } as const;

/** "This week · Oct 27 – Nov 1", "Today · Nov 1", or a custom range's dates. */
function rangeWords(range: DashboardRangeInput, shown: OverviewDashboard["range"] | undefined, today: string) {
  const dates = shown
    ? formatBusinessDateSpan(shown.startBusinessDate, shown.endBusinessDateInclusive, today)
    : null;
  if (range.kind === "custom") return dates ?? "Custom range";
  return dates ? `${PRESET_WORDS[range.preset]} · ${dates}` : PRESET_WORDS[range.preset];
}

export function DashboardPageClient() {
  usePageTitle("Overview");
  const { isAdmin } = useRole();
  const { loaded, setting } = useBusinessDay();
  const now = useNow();
  const [range, setRange] = useState<DashboardRangeInput>({ kind: "preset", preset: "today" });
  // Today reads Convex live, and so does today's part of a longer range; the
  // days before today read ClickHouse once the page is switched
  // (docs/agents/reporting.md).
  const todayBusinessDate = businessDateForInstant(now, setting);
  const report = useAnalyticsReport({
    page: "overview",
    reportId: "overview.dashboard",
    plan: dashboardRangePlan(range, todayBusinessDate),
    live: api.dashboard.overview.getOverviewDashboard,
    liveArgs: isAdmin && loaded ? { range } : "skip",
    todayArgs: isAdmin && loaded ? { range: dashboardRangeFromToday(range, todayBusinessDate) } : "skip",
    merge: mergeOverviewDashboard,
  });

  // A new range keeps the last one's numbers on screen, dimmed, until it
  // arrives (DESIGN.md, Kept Data While Reloading).
  // The kept numbers keep their own range, so their labels still match them.
  const [kept, setKept] = useState(report.data && { data: report.data, range });
  if (report.data !== undefined && report.data !== kept?.data) setKept({ data: report.data, range });
  const overview = report.data ?? kept?.data;
  const reloading = report.data === undefined && kept !== undefined;
  const shownInput = report.data === undefined && kept ? kept.range : range;

  useReportOverviewSectionError("leadGen", report.data?.leadGen);
  useReportOverviewSectionError("topQualifiers", report.data?.topQualifiers);
  useReportOverviewSectionError("topDmClosers", report.data?.topDmClosers);
  useReportOverviewSectionError("phoneCloserOperations", report.data?.phoneCloserOperations);
  useReportOverviewSectionError("topOrigins", report.data?.topOrigins);

  // A ClickHouse range can take a while to load; once the page has shown
  // anything, keep the band and its status on screen instead of the skeleton.
  if (!isAdmin || (!overview && report.source !== "warehouse")) {
    return <OverviewDashboardSkeleton />;
  }

  const freshness = freshnessSummary([report.freshness], now);
  const shownRange = overview?.range;

  return (
    <div className="@container mx-auto flex w-full max-w-[1500px] flex-col gap-3.5 pb-6 short:gap-3">
      <PageBand
        title="Overview"
        description={
          <>
            <span className="font-medium text-board-foreground">{rangeWords(shownInput, shownRange, todayBusinessDate)}</span>
            {freshness.kind === "line" ? (
              <>
                {" · "}
                <FreshnessWords summary={freshness} />
              </>
            ) : null}
            <span className="hidden @3xl:inline"> · {businessDayDisclosure(setting)}</span>
          </>
        }
        actions={
          <DateRangePicker
            tone="board"
            value={range}
            todayBusinessDate={todayBusinessDate}
            onChange={(next) => {
              if (next.kind === "preset" || validateCustomDashboardRange(next) === null) setRange(next);
            }}
          />
        }
      />

      <AnalyticsFreshnessAlert summary={freshness} />

      {overview ? (
        <div
          aria-busy={reloading}
          className={cn("flex flex-col gap-3.5 transition-opacity duration-200 short:gap-3", reloading && "opacity-60")}
        >
          <section aria-label="Rankings" className="grid gap-3.5 @4xl:grid-cols-3 short:gap-3">
            <LeadGenRanking section={overview.leadGen} range={shownInput} />
            <QualifiersRanking section={overview.topQualifiers} range={shownInput} />
            <DmClosersRanking section={overview.topDmClosers} range={shownInput} />
          </section>
          <div className="grid items-start gap-3.5 @5xl:grid-cols-[1.35fr_1fr] short:gap-3">
            <PhoneCloserOperationsSection section={overview.phoneCloserOperations} rangePhrase={rangePhrase(shownInput)} />
            <TopOriginsOverviewSection
              section={overview.topOrigins}
              rangePhrase={rangePhrase(shownInput)}
              todayBusinessDate={todayBusinessDate}
            />
          </div>
        </div>
      ) : (
        <OverviewSectionsSkeleton />
      )}
    </div>
  );
}
