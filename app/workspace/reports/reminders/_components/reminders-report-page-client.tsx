"use client";

import { useState } from "react";
import { addDays, startOfDay } from "date-fns";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { reportRangePlan, reportWindowFromToday } from "@/lib/analyticsRange";
import { mergeReminderOutcomeFunnel } from "@/convex/analytics/merge/reminders";
import { AnalyticsFreshnessAlert, freshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import {
  ReportDateControls,
  reportDayLine,
  reportRangePhrase,
  reportRangeWords,
  type DateRange,
} from "../../_components/report-date-controls";
import { ReportProgramFilter } from "../../_components/report-program-filter";
import { ReportPaymentTypeFilter, type PaymentType } from "../../_components/report-payment-type-filter";
import { REPORT_PAGE, ReportBand } from "../../_components/report-ui";
import { PerCloserReminderConversionTable } from "./per-closer-reminder-conversion-table";
import { ReminderChainLengthHistogram } from "./reminder-chain-length-histogram";
import { ReminderFigures } from "./reminder-figures";
import { ReminderOutcomeStrip } from "./reminder-outcome-strip";
import { REMINDERS_BAND_TITLE, REMINDERS_PAIR } from "./reminders-report-config";

function getDefaultDateRange(): DateRange {
  const now = new Date();
  return {
    startDate: startOfDay(now).getTime(),
    endDate: startOfDay(addDays(now, 1)).getTime(),
  };
}

export function RemindersReportPageClient() {
  usePageTitle("Reminder Outcomes — Reports");
  const { setting } = useBusinessDay();

  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [programId, setProgramId] = useState<Id<"tenantPrograms"> | undefined>();
  const [paymentType, setPaymentType] = useState<PaymentType | undefined>();

  const queryArgs = {
    ...dateRange,
    ...(programId ? { programId } : {}),
    ...(paymentType ? { paymentType } : {}),
  };

  // Today reads Convex live, and so does today's part of a longer range; the
  // days before today read ClickHouse once the page is switched
  // (docs/agents/reporting.md).
  const now = useNow();
  const report = useAnalyticsReport({
    page: "reminders",
    reportId: "reminders.funnel",
    plan: reportRangePlan(dateRange, now),
    filters: { programId, paymentType },
    live: api.reporting.remindersReporting.getReminderOutcomeFunnel,
    liveArgs: queryArgs,
    todayArgs: { ...queryArgs, ...reportWindowFromToday(dateRange, now) },
    merge: mergeReminderOutcomeFunnel,
  });
  // A new range or filter keeps the last numbers on screen, dimmed, with the
  // range they were loaded for (Kept Data While Reloading).
  const kept = useKeptWhileLoading(report.data, reportRangePhrase(dateRange));
  const [keptRange, setKeptRange] = useState(dateRange);
  if (report.data !== undefined && keptRange !== dateRange) setKeptRange(dateRange);
  const shownRange = kept.reloading ? keptRange : dateRange;
  const data = kept.data;
  const freshness = freshnessSummary([report.freshness], now);
  const empty = data !== undefined && data.totalCreated === 0;

  return (
    <div className={REPORT_PAGE}>
      <ReportBand
        title={REMINDERS_BAND_TITLE}
        range={reportRangeWords(shownRange)}
        freshness={report.data !== undefined ? freshness : null}
        sentence="Manual reminders only"
        dayLine={reportDayLine("browser", setting)}
        actions={<ReportDateControls value={dateRange} onChange={setDateRange} />}
        figures={<ReminderFigures data={data} rangePhrase={kept.phrase} reloading={kept.reloading} />}
        filters={
          <>
            <ReportProgramFilter value={programId} onChange={setProgramId} />
            <ReportPaymentTypeFilter value={paymentType} onChange={setPaymentType} />
          </>
        }
      />
      <AnalyticsFreshnessAlert summary={freshness} />

      <ReminderOutcomeStrip data={data} rangePhrase={kept.phrase} reloading={kept.reloading} />
      {empty ? null : (
        <div className={REMINDERS_PAIR}>
          <PerCloserReminderConversionTable data={data} reloading={kept.reloading} />
          <ReminderChainLengthHistogram data={data} reloading={kept.reloading} />
        </div>
      )}
    </div>
  );
}
