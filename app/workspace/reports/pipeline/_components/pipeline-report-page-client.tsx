"use client";

import { useCallback, useEffect, useState } from "react";
import { addDays, startOfDay } from "date-fns";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { mergePipelineBacklogAndLoss, mergeSchedulingShowRate } from "@/convex/analytics/merge/pipeline";
import { AnalyticsFreshnessAlert, freshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { BusinessDayRebuildingState } from "@/app/workspace/_components/day-definition";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { dashboardRangePlan, reportRangePlan, reportWindowFromToday } from "@/lib/analyticsRange";
import { addBusinessDays, businessDateForInstant } from "@/lib/businessDay";
import { reportRangeDayKeys } from "@/lib/reportDateRange";
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
import { LossAttributionCard } from "./loss-attribution-card";
import { NoShowSourcesCard } from "./no-show-sources-card";
import { PipelineAgingTable } from "./pipeline-aging-table";
import { PipelineFigures } from "./pipeline-figures";
import { StageDistributionCard } from "./stage-distribution-card";
import { StalePipelineList } from "./stale-pipeline-list";

// Pipeline Health: the band's range figures (booked calls and their show
// rate, by the band's filters) beside the pipeline right now (stale deals,
// open reminders, velocity); then the live stage and aging cards, the stale
// deals, and the range's no-show sources and losses.

function getTodayRange(nowMs = Date.now()): DateRange {
  const now = new Date(nowMs);
  return {
    startDate: startOfDay(now).getTime(),
    endDate: startOfDay(addDays(now, 1)).getTime(),
  };
}

function capitalize(words: string) {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function PipelineReportPageClient() {
  usePageTitle("Pipeline Health");
  const { loaded, rebuilding, setting } = useBusinessDay();
  const { captureViewed, captureFiltersChanged } = useReportAnalytics("pipeline_health");

  const [dateRange, setDateRange] = useState<DateRange>(() => getTodayRange());
  const [attributionFilters, setAttributionFilters] = useState<ReportAttributionFilterValue>({});

  useEffect(() => {
    captureViewed();
  }, [captureViewed]);

  const captureOperationsFilterChange = useCallback(
    (next?: ReportAttributionFilterValue) => {
      const filters = next ?? attributionFilters;
      captureFiltersChanged({
        date_range_preset: "custom",
        has_booking_program_filter: Boolean(filters.bookingProgramId),
        has_attribution_team_filter: Boolean(filters.attributionTeamId),
        has_dm_closer_filter: Boolean(filters.dmCloserId),
      });
    },
    [attributionFilters, captureFiltersChanged],
  );

  const distribution = useQuery(api.reporting.pipelineHealth.getPipelineDistribution);
  const aging = useQuery(api.reporting.pipelineHealth.getPipelineAging);
  // Today reads Convex live, and so does today's part of a longer range; the
  // days before today read ClickHouse once the page is switched
  // (docs/agents/reporting.md).
  const now = useNow();
  const plan = reportRangePlan(dateRange, now);
  const todayWindow = reportWindowFromToday(dateRange, now);
  const backlogAndLossReport = useAnalyticsReport({
    page: "pipeline",
    reportId: "pipeline.backlog_and_loss",
    plan,
    live: api.reporting.pipelineHealth.getPipelineBacklogAndLoss,
    liveArgs: {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
    },
    todayArgs: todayWindow,
    merge: mergePipelineBacklogAndLoss,
  });
  // The show rate counts the tenant's business days, so its range is planned
  // in them: between midnight and the business day's start, the browser's
  // today is a business day ahead.
  const showRateDays = reportRangeDayKeys(dateRange);
  const todayBusinessDate = businessDateForInstant(now, setting);
  const showRatePlan = dashboardRangePlan(
    {
      kind: "custom",
      startBusinessDate: showRateDays.startDayKey,
      endBusinessDateInclusive: addBusinessDays(showRateDays.endDayKeyExclusive, -1),
    },
    todayBusinessDate,
  );
  const operationsShowRateReport = useAnalyticsReport({
    page: "pipeline",
    reportId: "pipeline.show_rate",
    plan: showRatePlan,
    filters: {
      bookingProgramId: attributionFilters.bookingProgramId,
      attributionTeamId: attributionFilters.attributionTeamId,
      dmCloserId: attributionFilters.dmCloserId,
    },
    live: api.reporting.pipelineHealth.getSchedulingShowRateByOperationsDimensions,
    liveArgs: !loaded || rebuilding ? "skip" : {
      ...showRateDays,
      ...attributionFilters,
    },
    todayArgs: !loaded || rebuilding ? "skip" : {
      startDayKey:
        showRateDays.startDayKey > todayBusinessDate ? showRateDays.startDayKey : todayBusinessDate,
      endDayKeyExclusive: showRateDays.endDayKeyExclusive,
      ...attributionFilters,
    },
    merge: mergeSchedulingShowRate,
  });
  const backlogAndLoss = backlogAndLossReport.data;
  const operationsShowRate = operationsShowRateReport.data;
  // A split already includes the live backlog. Only a wholly historical
  // warehouse range needs a separate live read for this current-state figure.
  const needsLiveBacklog = backlogAndLossReport.source === "warehouse" && plan.kind === "warehouse";
  const liveBacklog = useQuery(
    api.reporting.pipelineHealth.getPipelineBacklogAndLoss,
    needsLiveBacklog ? getTodayRange(now) : "skip",
  );
  const reminderBacklog = needsLiveBacklog ? liveBacklog : backlogAndLoss;
  const freshness = freshnessSummary([backlogAndLossReport.freshness, operationsShowRateReport.freshness], now);

  // A new range or filter keeps the last numbers on screen, dimmed, with the
  // range phrase they were loaded for (DESIGN.md, Kept Data While Reloading).
  const phrase = reportRangePhrase(dateRange);
  const keptBacklog = useKeptWhileLoading(backlogAndLoss, phrase);
  const keptShowRate = useKeptWhileLoading(operationsShowRate, phrase);
  const keptReminders = useKeptWhileLoading(reminderBacklog, phrase);
  const rangeLabel = capitalize(keptBacklog.phrase);

  return (
    <div className={REPORT_PAGE}>
      <ReportBand
        title="Pipeline Health"
        range={reportRangeWords(dateRange)}
        freshness={backlogAndLoss !== undefined && operationsShowRate !== undefined ? freshness : null}
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
          <PipelineFigures
            showRate={keptShowRate.data}
            showRateReloading={keptShowRate.reloading}
            rebuilding={rebuilding}
            aging={aging}
            reminders={keptReminders.data}
          />
        }
        filters={
          <ReportAttributionFilters
            value={attributionFilters}
            onChange={(next) => {
              setAttributionFilters(next);
              captureOperationsFilterChange(next);
            }}
          />
        }
      />
      <AnalyticsFreshnessAlert summary={freshness} />
      {rebuilding ? <BusinessDayRebuildingState /> : null}

      <div className={REPORT_PAIR}>
        <StageDistributionCard distribution={distribution?.distribution} />
        <PipelineAgingTable agingByStage={aging?.agingByStage} />
      </div>

      <StalePipelineList staleCount={aging?.staleCount} staleOpps={aging?.staleOpps} />

      <div className={REPORT_PAIR}>
        <NoShowSourcesCard
          split={keptBacklog.data?.noShowSourceSplit}
          rangeLabel={rangeLabel}
          rangePhrase={keptBacklog.phrase}
          reloading={keptBacklog.reloading}
        />
        <LossAttributionCard
          lossAttribution={keptBacklog.data?.lossAttribution}
          isTruncated={keptBacklog.data?.isLossAttributionTruncated ?? false}
          rangeLabel={rangeLabel}
          rangePhrase={keptBacklog.phrase}
          reloading={keptBacklog.reloading}
        />
      </div>
    </div>
  );
}
