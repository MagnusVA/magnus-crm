"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  mergeAnswerDistribution,
  mergeFormResponseKpis,
  mergeLeadConversionMetrics,
} from "@/convex/analytics/merge/leads";
import { AnalyticsFreshnessAlert, freshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import { REPORT_PAGE, REPORT_PAIR, ReportBand } from "../../_components/report-ui";
import { ReportRangeMessage, ReportRangePicker, useReportRange } from "../../_components/use-report-range";
import { ConversionByCloserTable } from "./conversion-by-closer-table";
import { FormResponseAnalyticsSection } from "./form-response-analytics-section";
import { LeadsFigures } from "./leads-figures";
import { TopAnswerPerFieldList } from "./top-answer-per-field-list";

// Leads & Conversions: the band's six figures, then conversions by closer
// beside each form field's top answer, and one field's answers in full.

export function LeadsReportPageClient() {
  usePageTitle("Leads & Conversions");
  const range = useReportRange();
  const [selectedFieldKey, setSelectedFieldKey] = useState<string | null>(null);

  // Today reads Convex live, and so does today's part of a longer range; the
  // days before today read ClickHouse once the page is switched
  // (docs/agents/reporting.md).
  const now = useNow();
  const { plan, todayWindow, loaded } = range;
  const rangeArgs = range.window;
  const metricsReport = useAnalyticsReport({
    page: "leads",
    reportId: "leads.conversion_metrics",
    plan,
    live: api.reporting.leadConversion.getLeadConversionMetrics,
    liveArgs: loaded ? rangeArgs : "skip",
    todayArgs: loaded ? todayWindow : "skip",
    merge: mergeLeadConversionMetrics,
  });
  const formKpisReport = useAnalyticsReport({
    page: "leads",
    reportId: "leads.form_kpis",
    plan,
    live: api.reporting.formResponseAnalytics.getFormResponseKpis,
    liveArgs: loaded ? rangeArgs : "skip",
    todayArgs: loaded ? todayWindow : "skip",
    merge: mergeFormResponseKpis,
  });
  const distributionReport = useAnalyticsReport({
    page: "leads",
    reportId: "leads.answer_distribution",
    plan,
    filters: { fieldKey: selectedFieldKey },
    live: api.reporting.formResponseAnalytics.getAnswerDistribution,
    liveArgs: loaded && selectedFieldKey
      ? { fieldKey: selectedFieldKey, ...rangeArgs }
      : "skip",
    todayArgs: loaded && selectedFieldKey
      ? { fieldKey: selectedFieldKey, ...todayWindow }
      : "skip",
    merge: mergeAnswerDistribution,
  });
  const catalog = useQuery(api.reporting.formResponseAnalytics.getFieldCatalog);
  const fieldLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const field of catalog ?? []) if (!labels.has(field.fieldKey)) labels.set(field.fieldKey, field.currentLabel);
    return labels;
  }, [catalog]);

  const freshness = freshnessSummary(
    [metricsReport.freshness, formKpisReport.freshness, ...(selectedFieldKey ? [distributionReport.freshness] : [])],
    now,
  );

  // A new range keeps the last numbers on screen, dimmed, with the range
  // phrase they were loaded for (DESIGN.md, Kept Data While Reloading).
  const phrase = range.phrase;
  const metrics = useKeptWhileLoading(metricsReport.data, phrase);
  const formKpis = useKeptWhileLoading(formKpisReport.data, phrase);

  return (
    <div className={REPORT_PAGE}>
      <ReportBand
        title="Leads & Conversions"
        range={range.words}
        freshness={metricsReport.data !== undefined && formKpisReport.data !== undefined ? freshness : null}
        dayLine={range.dayLine}
        actions={
          <ReportRangePicker
            range={range}
            // The form section reloaded with a new range and lost its field.
            onChange={() => setSelectedFieldKey(null)}
          />
        }
        figures={
          <LeadsFigures
            metrics={metrics.data}
            formKpis={formKpis.data}
            rangePhrase={metrics.phrase}
            reloading={metrics.reloading || formKpis.reloading}
          />
        }
      />
      <ReportRangeMessage range={range} />
      <AnalyticsFreshnessAlert summary={freshness} />

      <div className={REPORT_PAIR}>
        <ConversionByCloserTable
          byCloser={metrics.data?.byCloser}
          totalConversions={metrics.data?.totalConversions}
          rangePhrase={metrics.phrase}
          reloading={metrics.reloading}
        />
        <TopAnswerPerFieldList
          rows={formKpis.data?.topAnswerPerField}
          fieldLabels={fieldLabels}
          rangePhrase={formKpis.phrase}
          reloading={formKpis.reloading}
        />
      </div>

      <FormResponseAnalyticsSection
        catalog={catalog}
        selectedFieldKey={selectedFieldKey}
        onSelectedFieldKeyChange={setSelectedFieldKey}
        distribution={distributionReport.data}
        rangePhrase={phrase}
      />
    </div>
  );
}
