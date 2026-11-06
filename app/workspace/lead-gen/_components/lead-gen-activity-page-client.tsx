"use client";

import { useState } from "react";
import { usePaginatedQuery } from "convex-helpers/react";
import { api } from "@/convex/_generated/api";
import { mergeMyActivitySummary } from "@/convex/analytics/merge/leadGen";
import {
  AnalyticsFreshnessAlert,
  FreshnessWords,
  freshnessSummary,
} from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport, useAnalyticsSource } from "@/app/workspace/_components/analytics/use-analytics-report";
import { dashboardRangeToDayKeys } from "@/app/workspace/_components/dashboard-date-utils";
import { DateRangePicker, formatBusinessDateSpan, rangePhrase } from "@/app/workspace/_components/date-range-picker";
import { PageBand } from "@/app/workspace/_components/page-band";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { useDashboardRange } from "@/app/workspace/_components/use-dashboard-range";
import { SectionError } from "@/app/workspace/closer/_components/section-state";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import { CARD, HelpTip } from "@/app/workspace/team/_components/team-ui";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { dashboardRangeFromToday, dashboardRangePlan } from "@/lib/analyticsRange";
import { BUSINESS_DAY_REBUILD_MESSAGE, businessDateForInstant, businessDayDisclosure } from "@/lib/businessDay";
import { ACTIVITY_PAGE_SIZE, ActivitySubmissionsCard } from "./activity-submissions-card";
import { ActivityZones } from "./activity-zones";
import { ACTIVITY_ROOT, type ActivityRow } from "./setter-ui";

const PRESET_WORDS = { today: "Today", this_week: "This week", this_month: "This month" } as const;

/** The board-tone picker on a phone: presets and an icon-only date button share one row (No-shows' grammar). */
const PICKER_PHONE =
  "@max-xl:flex-nowrap @max-xl:gap-1.5 @max-xl:[&_[aria-haspopup]]:px-2.5 @max-xl:[&_[aria-haspopup]>span]:sr-only @max-xl:[&_[role=radio]]:px-2";

export function LeadGenActivityPageClient() {
  usePageTitle("My activity");
  const { setting, rebuilding, loaded } = useBusinessDay("lead-gen");
  const now = useNow();
  const todayBusinessDate = businessDateForInstant(now, setting);
  const { range, setRange, queryRange, validationMessage } = useDashboardRange();

  // Today reads Convex live, and so does today's part of a longer range; the
  // days before today read ClickHouse once the page is switched
  // (docs/agents/reporting.md).
  const plan = dashboardRangePlan(queryRange, todayBusinessDate);
  const warehouse = useAnalyticsSource("my_activity", plan) === "warehouse";
  const summaryReport = useAnalyticsReport({
    page: "my_activity",
    reportId: "my_activity.summary",
    plan,
    live: api.leadGen.activity.getMyActivitySummary,
    merge: mergeMyActivitySummary,
    todayArgs: !loaded || rebuilding ? "skip" : { range: dashboardRangeFromToday(queryRange, todayBusinessDate) },
    liveArgs: !loaded || (!warehouse && rebuilding) ? "skip" : { range: queryRange },
  });

  const { startDayKey, endDayKey } = dashboardRangeToDayKeys(queryRange, now, setting);
  const dates = formatBusinessDateSpan(startDayKey, endDayKey, todayBusinessDate);
  const phrase = rangePhrase(queryRange);

  // A new range keeps the last figures and rows at 60% until its own arrive
  // (DESIGN.md, Kept Data While Reloading).
  const summary = useKeptWhileLoading(summaryReport.data, phrase);

  // The band names the days its figures cover, from the range the server
  // read, so figures a query still holds from before midnight never wear
  // today's date: "Today · Nov 5", "This week · Nov 2 – Nov 5", or the dates.
  const figuresStart = summary.data?.range.startBusinessDate ?? startDayKey;
  const figuresEnd = summary.data?.range.endBusinessDateInclusive ?? endDayKey;
  const figuresDates = formatBusinessDateSpan(figuresStart, figuresEnd, todayBusinessDate);
  const words =
    queryRange.kind === "preset" && figuresStart === startDayKey && figuresEnd === endDayKey
      ? `${PRESET_WORDS[queryRange.preset]} · ${figuresDates}`
      : figuresDates;

  const recent = usePaginatedQuery(
    api.leadGen.activity.listMyRecentSubmissions,
    !loaded || rebuilding ? "skip" : { range: queryRange },
    { initialNumItems: ACTIVITY_PAGE_SIZE },
  );
  const argsKey = JSON.stringify(queryRange);
  const fresh = !loaded || rebuilding || recent.status === "LoadingFirstPage" ? undefined : recent.results;
  const freshKey = fresh ? `${argsKey}|${fresh.map((row) => row._id).join(",")}` : undefined;
  // The rows keep the days they were read for: they can arrive before or
  // after the figures, and a query can hold them past midnight.
  const [kept, setKept] = useState<{
    key: string;
    rows: ActivityRow[];
    phrase: string;
    dates: string;
    singleDay: boolean;
  } | null>(null);
  if (fresh && freshKey !== undefined && freshKey !== kept?.key) {
    setKept({ key: freshKey, rows: fresh, phrase, dates, singleDay: startDayKey === endDayKey });
  }
  const rows = fresh ?? kept?.rows;
  const rowsReloading = fresh === undefined && kept !== null;
  const shownPhrase = kept?.phrase ?? phrase;
  // One day's rows show the time only; the band, or the card, names the day.
  const shownSingleDay = kept?.singleDay ?? startDayKey === endDayKey;
  const rowsDates = kept?.dates ?? dates;

  const freshness = freshnessSummary([summaryReport.freshness], now);

  return (
    <div className={ACTIVITY_ROOT}>
      <PageBand
        title="My activity"
        description={
          <>
            <HelpTip tip={`${businessDayDisclosure(setting)}.`} className="font-medium text-board-foreground">
              {words}
            </HelpTip>
            {freshness.kind === "line" && summary.data !== undefined ? (
              <>
                {" · "}
                <FreshnessWords summary={freshness} />
              </>
            ) : null}
            <span className="hidden @3xl:inline"> · Your captures and worked resparks.</span>
            {validationMessage ? (
              <span role="alert" className="block text-board-danger">
                {validationMessage}
              </span>
            ) : null}
          </>
        }
        actions={
          <div className="flex min-w-0 items-center @max-xl:w-full">
            <DateRangePicker
              tone="board"
              value={range}
              onChange={setRange}
              todayBusinessDate={todayBusinessDate}
              className={PICKER_PHONE}
            />
          </div>
        }
      >
        {rebuilding ? null : <ActivityZones summary={summary.data} reloading={summary.reloading} />}
      </PageBand>

      <AnalyticsFreshnessAlert summary={freshness} />

      {rebuilding ? (
        <div className={CARD}>
          <p role="status" className="px-4 py-3 text-[13px] text-muted-foreground">
            {BUSINESS_DAY_REBUILD_MESSAGE} Your figures and submissions are back once it finishes.
          </p>
        </div>
      ) : (
        <SectionErrorBoundary
          sectionName="lead_gen_my_activity_submissions"
          fallback={
            <div className={CARD}>
              <SectionError what="your submissions" />
            </div>
          }
        >
          <ActivitySubmissionsCard
            rows={rows}
            reloading={rowsReloading}
            canLoadMore={recent.status === "CanLoadMore"}
            loadingMore={recent.status === "LoadingMore"}
            onLoadMore={() => recent.loadMore(ACTIVITY_PAGE_SIZE)}
            emptyTitle={`Nothing captured ${shownPhrase}.`}
            timeZone={setting.timeZone}
            singleDay={shownSingleDay}
            // Said only while the list and the figures cover different days.
            dates={rowsDates === figuresDates ? null : rowsDates}
          />
        </SectionErrorBoundary>
      )}
    </div>
  );
}
