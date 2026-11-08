"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ListChecksIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { mergeSlackQualifications } from "@/convex/analytics/merge/slackQualifications";
import { AnalyticsFreshnessAlert, freshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { BUSINESS_DAY_REBUILD_MESSAGE } from "@/lib/businessDay";
import { cn } from "@/lib/utils";
import { BAND_BUTTON, REPORT_PAGE, ReportBand, ReportGranularitySelect } from "../../_components/report-ui";
import { useReportAnalytics } from "../../_components/use-report-analytics";
import { ReportRangeMessage, ReportRangePicker, useReportRange } from "../../_components/use-report-range";
import {
  getRangeValidationMessage,
  type SlackQualificationFilters,
  type SlackQualificationGranularity,
} from "./business-date-utils";
import { SetterContributionCard } from "./setter-contribution-card";
import { SetterFilter } from "./setter-qualification-controls";
import { SetterQualificationFigures } from "./setter-qualification-figures";
import { SetterQualificationTrend } from "./setter-qualification-trend";

// Slack Qualifications: the band with the shared picker and the trend's
// granularity, six figures and the setter filter, then the trend and each
// setter's events. Operations › Qualifications (the Split Desk) reads the
// same events by lead; this report keeps the per-period trend and the
// event-level counts.

export function SlackQualificationReportPageClient() {
  usePageTitle("Slack Qualifications - Reports");
  const { captureViewed, captureFiltersChanged } = useReportAnalytics(
    "slack_qualifications",
  );

  const range = useReportRange();
  const { loaded, rebuilding, plan } = range;
  const now = useNow();
  const [granularity, setGranularity] = useState<SlackQualificationGranularity>("day");
  const [slackUserId, setSlackUserId] = useState<string | null>(null);
  const filters: SlackQualificationFilters = useMemo(
    () => ({
      startBusinessDate: range.dates.startBusinessDate,
      endBusinessDateExclusive: range.dayKeys.endDayKeyExclusive,
      granularity,
      slackUserId,
    }),
    [granularity, range.dates.startBusinessDate, range.dayKeys.endDayKeyExclusive, slackUserId],
  );
  // The picker caps the range's length; the report also caps how many
  // periods the trend may draw at this granularity.
  const rangeError = getRangeValidationMessage(filters);
  // The events are read by business date, which isn't known until the
  // tenant's day definition loads. A rebuild only adds its notice.

  const queryArgs = useMemo(() => {
    if (rangeError || !loaded) {
      return "skip" as const;
    }

    const base = {
      startBusinessDate: filters.startBusinessDate,
      endBusinessDateExclusive: filters.endBusinessDateExclusive,
      granularity: filters.granularity,
    };

    return filters.slackUserId
      ? { ...base, slackUserId: filters.slackUserId }
      : base;
  }, [filters, loaded, rangeError]);

  // Today reads Convex live, and so does today's part of a longer range; the
  // days before today read ClickHouse once the page is switched
  // (docs/agents/reporting.md).
  const reportResult = useAnalyticsReport({
    page: "slack_qualifications",
    reportId: "slack_qualifications.report",
    plan,
    filters: { granularity: filters.granularity, slackUserId: filters.slackUserId },
    live: api.reporting.slackQualifications.getQualificationReport,
    liveArgs: queryArgs,
    todayArgs: queryArgs === "skip" ? "skip" : {
      ...queryArgs,
      startBusinessDate: range.todayDayKeys.startDayKey,
      endBusinessDateExclusive: range.todayDayKeys.endDayKeyExclusive,
    },
    merge: mergeSlackQualifications,
  });

  useEffect(() => {
    captureViewed();
  }, [captureViewed]);

  const operationsHref = useMemo(() => {
    const params = new URLSearchParams({
      range: "custom",
      from: range.dates.startBusinessDate,
      to: range.dates.endBusinessDateInclusive,
    });
    return `/workspace/operations/qualifications?${params.toString()}`;
  }, [range.dates.endBusinessDateInclusive, range.dates.startBusinessDate]);

  // A new range or setter keeps the last report on screen, dimmed, until the
  // new one arrives (DESIGN.md, Kept Data While Reloading). An invalid range
  // shows nothing kept: its line says why.
  const kept = useKeptWhileLoading(reportResult.data, range.phrase);
  const report = rangeError ? undefined : kept.data;
  const reloading = !rangeError && kept.reloading;
  const freshness = freshnessSummary([reportResult.freshness], now);
  const filteredToSetter = report ? report.selectedSlackUserId !== null : filters.slackUserId !== null;
  const setterName = filteredToSetter
    ? (report?.setters.find((setter) => setter.slackUserId === report.selectedSlackUserId)?.displayName ?? null)
    : null;
  const captureChange = (nextSlackUserId: string | null) =>
    captureFiltersChanged({
      date_range_preset: "custom",
      has_slack_setter_filter: Boolean(nextSlackUserId),
    });

  return (
    <>
      <div className={REPORT_PAGE}>
        <ReportBand
          title="Slack Qualifications"
          range={range.words}
          freshness={reportResult.data !== undefined ? freshness : null}
          dayLine={range.dayLine}
          actions={
            <>
              <ReportRangePicker range={range} onChange={() => captureChange(slackUserId)} />
              <ReportGranularitySelect
                value={granularity}
                onChange={(next) => {
                  setGranularity(next);
                  captureChange(slackUserId);
                }}
              />
            </>
          }
          figures={
            rangeError ? undefined : (
              <SetterQualificationFigures
                totals={report?.totals}
                filteredToSetter={filteredToSetter}
                granularity={filters.granularity}
                reloading={reloading}
              />
            )
          }
          filters={
            <>
              <SetterFilter
                setters={report?.setters ?? []}
                value={slackUserId}
                onChange={(next) => {
                  setSlackUserId(next);
                  captureChange(next);
                }}
              />
              <Link href={operationsHref} className={cn(BAND_BUTTON, "ml-auto inline-flex items-center gap-1.5 font-medium")}>
                <ListChecksIcon aria-hidden="true" className="size-4" />
                View events
              </Link>
            </>
          }
        />
        <ReportRangeMessage range={range} />

        {rangeError ? <p role="alert" className="text-[13px] text-danger-ink">{rangeError}</p> : null}
        {rebuilding ? <p role="status" className="text-[13px] text-muted-foreground">{BUSINESS_DAY_REBUILD_MESSAGE}</p> : null}
        <AnalyticsFreshnessAlert summary={freshness} />

        {rangeError ? null : (
          <>
            <SetterQualificationTrend
              periods={report?.periods}
              filteredToSetter={filteredToSetter}
              setterName={setterName}
              granularity={report?.granularity ?? filters.granularity}
              eventsTruncated={report?.totals.eventsTruncated ?? false}
              rangePhrase={kept.phrase}
              reloading={reloading}
            />
            <SetterContributionCard
              rows={report?.users}
              settersTruncated={report?.settersTruncated ?? false}
              rangePhrase={kept.phrase}
              reloading={reloading}
            />
          </>
        )}
      </div>
    </>
  );
}
