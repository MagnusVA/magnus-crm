"use client";

import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { FigureZone, ReportFigures } from "../../_components/report-ui";

// The band's six figures: new leads, conversions and their rate, then
// meetings per sale, time to conversion and the booking form's response rate.

type Metrics = FunctionReturnType<typeof api.reporting.leadConversion.getLeadConversionMetrics>;
type FormKpis = FunctionReturnType<typeof api.reporting.formResponseAnalytics.getFormResponseKpis>;

const wholeNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });

export function formatCount(value: number) {
  return wholeNumber.format(value);
}

function formatRate(value: number | null) {
  return value === null ? "—" : percent.format(value);
}

/** "9.4h" under a day, "9d 7h" from a day. */
function formatDurationMs(ms: number) {
  const totalHours = ms / 3_600_000;
  if (totalHours < 24) return `${totalHours.toFixed(1)}h`;
  const days = Math.floor(totalHours / 24);
  const hours = Math.round(totalHours - days * 24);
  return `${days}d ${hours}h`;
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

export function LeadsFigures({
  metrics,
  formKpis,
  rangePhrase,
  reloading,
}: {
  metrics: Metrics | undefined;
  formKpis: FormKpis | undefined;
  /** "this week", "today", "in this range": names the range in worded zeros. */
  rangePhrase: string;
  reloading?: boolean;
}) {
  return (
    <ReportFigures columns="grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-6" reloading={reloading}>
      <FigureZone
        label="New leads"
        help="People who reached Qualified in the range."
        figure={metrics && formatCount(metrics.newLeads)}
        proof={metrics && (metrics.newLeads === 0 ? `No new leads ${rangePhrase}` : "Reached Qualified")}
      />
      <FigureZone
        label="Conversions"
        help="Leads who became customers in the range."
        figure={metrics && formatCount(metrics.totalConversions)}
        proof={metrics && (metrics.totalConversions === 0 ? `No customers ${rangePhrase}` : "Became customers")}
      />
      <FigureZone
        label="Conversion rate"
        figure={metrics && formatRate(metrics.conversionRate)}
        proof={metrics && (metrics.conversionRate === null ? "No new leads to divide by" : "Conversions ÷ new leads")}
      />
      <FigureZone
        label="Meetings per sale"
        help="Meetings on the deals won in the range, divided by those deals."
        figure={metrics && (metrics.avgMeetingsPerSale === null ? "—" : metrics.avgMeetingsPerSale.toFixed(2))}
        proof={
          metrics &&
          (metrics.avgMeetingsPerSale === null
            ? "No won deals to average"
            : `${plural(metrics.meetingsPerSaleNumerator, "meeting")} ÷ ${plural(metrics.meetingsPerSaleDenominator, "won deal")}`)
        }
      />
      <FigureZone
        label="Time to convert"
        help="Average time from when the person was first seen to when they became a customer."
        figure={metrics && (metrics.avgTimeToConversionMs === null ? "—" : formatDurationMs(metrics.avgTimeToConversionMs))}
        proof={
          metrics &&
          (metrics.avgTimeToConversionMs === null
            ? "No conversions to average"
            : `Across ${plural(metrics.timeToConversionSampleCount, "conversion")}`)
        }
      />
      <FigureZone
        label="Form response rate"
        help="Meetings whose booking form had at least one answered field."
        figure={formKpis && formatRate(formKpis.formResponseRate)}
        proof={
          formKpis &&
          (formKpis.formResponseRate === null
            ? `No meetings ${rangePhrase}`
            : `${formatCount(formKpis.respondedMeetingsCount)} of ${plural(formKpis.totalMeetings, "meeting")}`)
        }
      />
    </ReportFigures>
  );
}
