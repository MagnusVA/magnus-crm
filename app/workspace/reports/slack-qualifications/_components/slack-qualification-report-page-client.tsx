"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ListChecksIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { mergeSlackQualifications } from "@/convex/analytics/merge/slackQualifications";
import { AnalyticsFreshnessAlert, freshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { dashboardRangePlan } from "@/lib/analyticsRange";
import { BUSINESS_DAY_REBUILD_MESSAGE, businessDateForInstant } from "@/lib/businessDay";
import { cn } from "@/lib/utils";
import { reportDayLine } from "../../_components/report-date-controls";
import { BAND_BUTTON, REPORT_PAGE, ReportBand } from "../../_components/report-ui";
import { useReportAnalytics } from "../../_components/use-report-analytics";
import {
  getInclusiveEndBusinessDate,
  getInitialSlackQualificationFilters,
  getRangeValidationMessage,
  type SlackQualificationFilters,
} from "./business-date-utils";
import { SetterContributionCard } from "./setter-contribution-card";
import {
  SetterFilter,
  SetterQualificationDateControls,
  slackRangePhrase,
  slackRangeWords,
} from "./setter-qualification-controls";
import { SetterQualificationFigures } from "./setter-qualification-figures";
import { SetterQualificationTrend } from "./setter-qualification-trend";

// Slack Qualifications: the band with its own business-date controls, six
// figures and the setter filter, then the trend and each setter's events.
// Operations › Qualifications (the Split Desk) reads the same events by lead;
// this report keeps the per-period trend and the event-level counts.

export function SlackQualificationReportPageClient() {
  usePageTitle("Slack Qualifications - Reports");
  const { captureViewed, captureFiltersChanged } = useReportAnalytics(
    "slack_qualifications",
  );

  const { setting, rebuilding } = useBusinessDay();
  const now = useNow();
  const [selectedFilters, setFilters] = useState<SlackQualificationFilters | null>(null);
  const filters = useMemo(() => selectedFilters ?? getInitialSlackQualificationFilters(setting, now), [selectedFilters, setting, now]);
  const rangeError = getRangeValidationMessage(filters);

  const queryArgs = useMemo(() => {
    if (rangeError) {
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
  }, [filters, rangeError]);

  // Today reads Convex live, and so does today's part of a longer range; the
  // days before today read ClickHouse once the page is switched
  // (docs/agents/reporting.md).
  const todayBusinessDate = businessDateForInstant(now, setting);
  const plan = dashboardRangePlan(
    {
      kind: "custom",
      startBusinessDate: filters.startBusinessDate,
      endBusinessDateInclusive: getInclusiveEndBusinessDate(filters.endBusinessDateExclusive),
    },
    todayBusinessDate,
  );
  const reportResult = useAnalyticsReport({
    page: "slack_qualifications",
    reportId: "slack_qualifications.report",
    plan,
    filters: { granularity: filters.granularity, slackUserId: filters.slackUserId },
    live: api.reporting.slackQualifications.getQualificationReport,
    liveArgs: queryArgs,
    todayArgs: queryArgs === "skip" ? "skip" : {
      ...queryArgs,
      startBusinessDate: queryArgs.startBusinessDate > todayBusinessDate ? queryArgs.startBusinessDate : todayBusinessDate,
    },
    merge: mergeSlackQualifications,
  });

  useEffect(() => {
    captureViewed();
  }, [captureViewed]);

  const operationsHref = useMemo(() => {
    const params = new URLSearchParams({
      range: "custom",
      from: filters.startBusinessDate,
      to: getInclusiveEndBusinessDate(filters.endBusinessDateExclusive),
    });
    return `/workspace/operations/qualifications?${params.toString()}`;
  }, [filters]);

  // A new range or setter keeps the last report on screen, dimmed, until the
  // new one arrives (DESIGN.md, Kept Data While Reloading). An invalid range
  // shows nothing kept: its line says why.
  const kept = useKeptWhileLoading(reportResult.data, slackRangePhrase(filters, setting));
  const report = rangeError ? undefined : kept.data;
  const reloading = !rangeError && kept.reloading;
  const freshness = freshnessSummary([reportResult.freshness], now);
  const filteredToSetter = report ? report.selectedSlackUserId !== null : filters.slackUserId !== null;
  const setterName = filteredToSetter
    ? (report?.setters.find((setter) => setter.slackUserId === report.selectedSlackUserId)?.displayName ?? null)
    : null;
  const onChange = (next: SlackQualificationFilters) => {
    setFilters(next);
    captureFiltersChanged({
      date_range_preset: "custom",
      has_slack_setter_filter: Boolean(next.slackUserId),
    });
  };

  return (
    <>
      <div className={REPORT_PAGE}>
        <ReportBand
          title="Slack Qualifications"
          range={slackRangeWords(filters, setting)}
          freshness={reportResult.data !== undefined ? freshness : null}
          dayLine={reportDayLine("tenant", setting)}
          actions={<SetterQualificationDateControls value={filters} onChange={onChange} />}
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
              <SetterFilter setters={report?.setters ?? []} value={filters} onChange={onChange} />
              <Link href={operationsHref} className={cn(BAND_BUTTON, "ml-auto inline-flex items-center gap-1.5 font-medium")}>
                <ListChecksIcon aria-hidden="true" className="size-4" />
                View events
              </Link>
            </>
          }
        />

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
