"use client";

import { useCallback, useEffect, useState } from "react";
import { addDays, startOfDay } from "date-fns";
import { api } from "@/convex/_generated/api";
import { mergeTeamActions, mergeTeamMetrics, mergeTeamOperations } from "@/convex/analytics/merge/team";
import { AnalyticsFreshnessAlert, freshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { BusinessDayRebuildingState } from "@/app/workspace/_components/day-definition";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { dashboardRangePlan } from "@/lib/analyticsRange";
import { addBusinessDays, businessDateForInstant, businessDayStart } from "@/lib/businessDay";
import { reportRangeDayKeys } from "@/lib/reportDateRange";
import { cn } from "@/lib/utils";
import {
  ReportAttributionFilters,
  type ReportAttributionFilterValue,
} from "../../_components/report-attribution-filters";
import {
  ReportDateControls,
  reportDayLine,
  reportRangePhrase,
  reportRangeWords,
  type DateRange,
} from "../../_components/report-date-controls";
import { REPORT_PAGE, REPORT_PAIR, ReportBand } from "../../_components/report-ui";
import { useReportAnalytics } from "../../_components/use-report-analytics";
import { CloserOperationsCard } from "./closer-operations-card";
import { CloserPerformanceCard } from "./closer-performance-card";
import { MeetingOutcomesCard } from "./meeting-outcomes-card";
import { TeamFigures } from "./team-figures";

// Team Performance: the band with seven figures and the operations filters,
// then Phone closer operations (the one card the filters narrow) beside the
// meeting outcomes, then each closer's calls and payments. Each section
// loads, empties and keeps its last numbers on its own.

function getDefaultDateRange(): DateRange {
  const now = new Date();
  return {
    startDate: startOfDay(now).getTime(),
    endDate: startOfDay(addDays(now, 1)).getTime(),
  };
}

export function TeamReportPageClient() {
  usePageTitle("Team Performance — Reports");
  const { setting, loaded, rebuilding } = useBusinessDay();
  const { captureViewed, captureFiltersChanged } =
    useReportAnalytics("team_performance");

  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [operationsFilters, setOperationsFilters] =
    useState<ReportAttributionFilterValue>({});

  useEffect(() => {
    captureViewed();
  }, [captureViewed]);

  const captureOperationsFilterChange = useCallback(
    (next?: ReportAttributionFilterValue) => {
      const filters = next ?? operationsFilters;
      captureFiltersChanged({
        date_range_preset: "custom",
        has_booking_program_filter: Boolean(filters.bookingProgramId),
        has_attribution_team_filter: Boolean(filters.attributionTeamId),
        has_dm_closer_filter: Boolean(filters.dmCloserId),
      });
    },
    [captureFiltersChanged, operationsFilters],
  );

  const dayKeys = reportRangeDayKeys(dateRange);
  const queryRange = !loaded || rebuilding ? "skip" : {
    startDate: businessDayStart(dayKeys.startDayKey, setting),
    endDate: businessDayStart(dayKeys.endDayKeyExclusive, setting),
  };

  // Today reads Convex live, and so does today's part of a longer range; the
  // days before today read ClickHouse once the page is switched
  // (docs/agents/reporting.md).
  const now = useNow();
  const todayBusinessDate = businessDateForInstant(now, setting);
  const todayStartDayKey = dayKeys.startDayKey > todayBusinessDate ? dayKeys.startDayKey : todayBusinessDate;
  const todayArgs = queryRange === "skip" ? "skip" : {
    startDate: businessDayStart(todayStartDayKey, setting),
    endDate: queryRange.endDate,
  };
  const plan = dashboardRangePlan(
    {
      kind: "custom",
      startBusinessDate: dayKeys.startDayKey,
      endBusinessDateInclusive: addBusinessDays(dayKeys.endDayKeyExclusive, -1),
    },
    todayBusinessDate,
  );
  const metricsReport = useAnalyticsReport({
    page: "team",
    reportId: "team.metrics",
    plan,
    live: api.reporting.teamPerformance.getTeamPerformanceMetrics,
    liveArgs: queryRange,
    todayArgs,
    merge: mergeTeamMetrics,
  });
  // A payment or a reschedule today can change the outcome of an earlier
  // call, which neither half of a split would see, so the outcome mix reads
  // the whole range from ClickHouse, as of the last sync.
  const outcomeMixReport = useAnalyticsReport({
    page: "team",
    reportId: "team.outcomes",
    plan,
    live: api.reporting.teamOutcomes.getTeamOutcomeMix,
    liveArgs: queryRange,
    todayArgs: "skip",
    merge: null,
  });
  const actionsReport = useAnalyticsReport({
    page: "team",
    reportId: "team.actions",
    plan,
    live: api.reporting.teamActions.getActionsPerCloserPerDay,
    liveArgs: queryRange,
    todayArgs,
    merge: mergeTeamActions,
  });
  const operationsReport = useAnalyticsReport({
    page: "team",
    reportId: "team.operations",
    plan,
    filters: operationsFilters,
    todayArgs: !loaded || rebuilding ? "skip" : {
      ...dayKeys,
      startDayKey: todayStartDayKey,
      ...operationsFilters,
    },
    merge: mergeTeamOperations,
    live: api.reporting.teamPerformance.getTeamOperationsDimensions,
    liveArgs: !loaded || rebuilding ? "skip" : {
      ...dayKeys,
      ...operationsFilters,
    },
  });

  // A new range or filter keeps each section's last numbers on screen,
  // dimmed, until its own report arrives (DESIGN.md, Kept Data While
  // Reloading); the range phrase travels with them.
  const phrase = reportRangePhrase(dateRange);
  const metrics = useKeptWhileLoading(metricsReport.data, phrase);
  const outcomeMix = useKeptWhileLoading(outcomeMixReport.data, phrase);
  const actions = useKeptWhileLoading(actionsReport.data, phrase);
  const operations = useKeptWhileLoading(operationsReport.data, phrase);

  const freshnessItems = [
    metricsReport.freshness,
    outcomeMixReport.freshness,
    actionsReport.freshness,
    operationsReport.freshness,
  ];
  const freshness = freshnessSummary(freshnessItems, now);
  const allLoaded =
    metricsReport.data !== undefined &&
    outcomeMixReport.data !== undefined &&
    actionsReport.data !== undefined &&
    operationsReport.data !== undefined;
  const filtered = Boolean(
    operationsFilters.bookingProgramId || operationsFilters.attributionTeamId || operationsFilters.dmCloserId,
  );

  return (
    <>
      <div className={REPORT_PAGE}>
        <ReportBand
          title="Team Performance"
          range={reportRangeWords(dateRange)}
          freshness={allLoaded ? freshness : null}
          dayLine={reportDayLine("tenant", setting)}
          actions={
            <ReportDateControls
              value={dateRange}
              onChange={(next) => {
                setDateRange(next);
                captureOperationsFilterChange();
              }}
            />
          }
          figures={
            rebuilding ? undefined : (
              <TeamFigures
                metrics={metrics.data}
                derived={outcomeMix.data?.derived}
                actions={actions.data}
                rangePhrase={metrics.phrase}
                reloading={metrics.reloading || outcomeMix.reloading || actions.reloading}
              />
            )
          }
          filters={
            <>
              <ReportAttributionFilters
                value={operationsFilters}
                onChange={(next) => {
                  setOperationsFilters(next);
                  captureOperationsFilterChange(next);
                }}
              />
              <p className="text-[13px] text-board-muted @3xl:ml-auto">Filters narrow Phone closer operations.</p>
            </>
          }
        />

        <AnalyticsFreshnessAlert summary={freshness} />

        {rebuilding ? (
          <BusinessDayRebuildingState />
        ) : (
          <>
            <div className={cn(REPORT_PAIR, "@5xl:grid-cols-[1.3fr_1fr]")}>
              <CloserOperationsCard
                data={operations.data}
                filtered={filtered}
                rangePhrase={operations.phrase}
                reloading={operations.reloading}
              />
              <MeetingOutcomesCard
                outcomeMix={outcomeMix.data}
                asOfSync={plan.kind === "split" && outcomeMixReport.source === "warehouse"}
                rangePhrase={outcomeMix.phrase}
                reloading={outcomeMix.reloading}
              />
            </div>
            <CloserPerformanceCard metrics={metrics.data} rangePhrase={metrics.phrase} reloading={metrics.reloading} />
          </>
        )}
      </div>
    </>
  );
}
