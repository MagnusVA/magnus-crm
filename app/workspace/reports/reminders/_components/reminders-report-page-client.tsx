"use client";

import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { mergeReminderOutcomeFunnel } from "@/convex/analytics/merge/reminders";
import { AnalyticsFreshnessAlert, freshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import { ReportProgramFilter } from "../../_components/report-program-filter";
import { ReportPaymentTypeFilter, type PaymentType } from "../../_components/report-payment-type-filter";
import { REPORT_PAGE, ReportBand } from "../../_components/report-ui";
import { ReportRangeMessage, ReportRangePicker, useReportRange } from "../../_components/use-report-range";
import { PerCloserReminderConversionTable } from "./per-closer-reminder-conversion-table";
import { ReminderChainLengthHistogram } from "./reminder-chain-length-histogram";
import { ReminderFigures } from "./reminder-figures";
import { ReminderOutcomeStrip } from "./reminder-outcome-strip";
import { REMINDERS_BAND_TITLE, REMINDERS_PAIR } from "./reminders-report-config";

export function RemindersReportPageClient() {
  usePageTitle("Reminder Outcomes — Reports");
  const range = useReportRange();
  const [programId, setProgramId] = useState<Id<"tenantPrograms"> | undefined>();
  const [paymentType, setPaymentType] = useState<PaymentType | undefined>();

  const filterArgs = {
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
    plan: range.plan,
    filters: { programId, paymentType },
    live: api.reporting.remindersReporting.getReminderOutcomeFunnel,
    liveArgs: range.loaded ? { ...range.window, ...filterArgs } : "skip",
    todayArgs: range.loaded ? { ...range.todayWindow, ...filterArgs } : "skip",
    merge: mergeReminderOutcomeFunnel,
  });
  // A new range or filter keeps the last numbers on screen, dimmed, with the
  // range they were loaded for (Kept Data While Reloading).
  const kept = useKeptWhileLoading(report.data, range.phrase);
  const [keptQueryRange, setKeptQueryRange] = useState(range.queryRange);
  if (report.data !== undefined && keptQueryRange !== range.queryRange) setKeptQueryRange(range.queryRange);
  const shownQueryRange = kept.reloading ? keptQueryRange : range.queryRange;
  const data = kept.data;
  const freshness = freshnessSummary([report.freshness], now);
  const empty = data !== undefined && data.totalCreated === 0;

  return (
    <div className={REPORT_PAGE}>
      <ReportBand
        title={REMINDERS_BAND_TITLE}
        range={range.wordsFor(shownQueryRange)}
        freshness={report.data !== undefined ? freshness : null}
        sentence="Manual reminders only"
        dayLine={range.dayLine}
        actions={<ReportRangePicker range={range} />}
        figures={<ReminderFigures data={data} rangePhrase={kept.phrase} reloading={kept.reloading} />}
        filters={
          <>
            <ReportProgramFilter value={programId} onChange={setProgramId} />
            <ReportPaymentTypeFilter value={paymentType} onChange={setPaymentType} />
          </>
        }
      />
      <ReportRangeMessage range={range} />
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
