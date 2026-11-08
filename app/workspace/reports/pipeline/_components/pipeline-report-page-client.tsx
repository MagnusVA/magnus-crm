"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { mergePipelineBacklogAndLoss, mergeSchedulingShowRate } from "@/convex/analytics/merge/pipeline";
import { AnalyticsFreshnessAlert, freshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { BusinessDayRebuildingState } from "@/app/workspace/_components/day-definition";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  ReportAttributionFilters,
  type ReportAttributionFilterValue,
} from "../../_components/report-attribution-filters";
import { REPORT_PAGE, REPORT_PAIR, ReportBand } from "../../_components/report-ui";
import { useReportAnalytics } from "../../_components/use-report-analytics";
import { ReportRangeMessage, ReportRangePicker, useReportRange } from "../../_components/use-report-range";
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

function capitalize(words: string) {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function PipelineReportPageClient() {
  usePageTitle("Pipeline Health");
  const range = useReportRange();
  const { ready, rebuilding, plan } = range;
  const { captureViewed, captureFiltersChanged } = useReportAnalytics("pipeline_health");

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
  // (docs/agents/reporting.md). The range is the tenant's business days, so
  // nothing reads until they're known; the show rate's buckets also wait out
  // a rebuild, while the backlog and losses read timestamps and carry on.
  const now = useNow();
  const loaded = ready || rebuilding;
  const backlogAndLossReport = useAnalyticsReport({
    page: "pipeline",
    reportId: "pipeline.backlog_and_loss",
    plan,
    live: api.reporting.pipelineHealth.getPipelineBacklogAndLoss,
    liveArgs: loaded ? range.window : "skip",
    todayArgs: loaded ? range.todayWindow : "skip",
    merge: mergePipelineBacklogAndLoss,
  });
  const operationsShowRateReport = useAnalyticsReport({
    page: "pipeline",
    reportId: "pipeline.show_rate",
    plan,
    filters: {
      bookingProgramId: attributionFilters.bookingProgramId,
      attributionTeamId: attributionFilters.attributionTeamId,
      dmCloserId: attributionFilters.dmCloserId,
    },
    live: api.reporting.pipelineHealth.getSchedulingShowRateByOperationsDimensions,
    liveArgs: ready ? { ...range.dayKeys, ...attributionFilters } : "skip",
    todayArgs: ready ? { ...range.todayDayKeys, ...attributionFilters } : "skip",
    merge: mergeSchedulingShowRate,
  });
  const backlogAndLoss = backlogAndLossReport.data;
  const operationsShowRate = operationsShowRateReport.data;
  // A split already includes the live backlog. Only a wholly historical
  // warehouse range needs a separate live read for this current-state figure;
  // the today window of a range that ended before today is today alone.
  const needsLiveBacklog = loaded && backlogAndLossReport.source === "warehouse" && plan.kind === "warehouse";
  const liveBacklog = useQuery(
    api.reporting.pipelineHealth.getPipelineBacklogAndLoss,
    needsLiveBacklog ? range.todayWindow : "skip",
  );
  const reminderBacklog = needsLiveBacklog ? liveBacklog : backlogAndLoss;
  const freshness = freshnessSummary([backlogAndLossReport.freshness, operationsShowRateReport.freshness], now);

  // A new range or filter keeps the last numbers on screen, dimmed, with the
  // range phrase they were loaded for (DESIGN.md, Kept Data While Reloading).
  const { phrase } = range;
  const keptBacklog = useKeptWhileLoading(backlogAndLoss, phrase);
  const keptShowRate = useKeptWhileLoading(operationsShowRate, phrase);
  const keptReminders = useKeptWhileLoading(reminderBacklog, phrase);
  const rangeLabel = capitalize(keptBacklog.phrase);

  return (
    <div className={REPORT_PAGE}>
      <ReportBand
        title="Pipeline Health"
        range={range.words}
        freshness={backlogAndLoss !== undefined && operationsShowRate !== undefined ? freshness : null}
        dayLine={range.dayLine}
        actions={<ReportRangePicker range={range} onChange={() => captureOperationsFilterChange()} />}
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
      <ReportRangeMessage range={range} />
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
