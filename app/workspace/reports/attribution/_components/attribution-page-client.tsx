"use client";

import { useReportViewed } from "../../_components/use-report-page";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { mergeAttributionLanes, mergeAttributionPaths } from "@/convex/analytics/merge/attribution";
import {
  AnalyticsFreshnessAlert,
  freshnessSummary,
} from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { REPORT_TERMS, termHelp } from "@/lib/reporting/definitions";
import { ReportExportMenu } from "../../_components/report-export-menu";
import { FigureZone, OtherFigure, REPORT_PAGE, REPORT_PAIR, ReportBand, ReportFigures } from "../../_components/report-ui";
import { ReportRangeMessage, ReportRangePicker, useReportRange } from "../../_components/use-report-range";
import { CurrencySelect, useRowsExport } from "../../scorecard/_components/report-currency";
import { formatCount, formatMoney, inCurrency, pickMainCurrency, shownCurrency } from "../../scorecard/_components/report-money";
import { LanesCard, PathsCard, ResponsibleCard, coverageProof } from "./attribution-cards";
import {
  ROLE_LABELS,
  ROLE_ORDER,
  attributionCurrencyWeights,
  buildAttributionDocument,
  formatCoverage,
  laneViews,
  pathRows,
  responsibleRows,
} from "./attribution-shape";
import { DealChainSheet } from "./deal-chain-sheet";

// Attribution (docs/reviews/reports-overhaul.html §11): who is responsible
// for how much of the range's cash, by role. Credit is a dealAttributions row
// with a role and a source; there are no commission shares.

export function AttributionPageClient() {
  usePageTitle("Attribution");
  useReportViewed("attribution");
  const now = useNow();
  const range = useReportRange();
  const [requestedCurrency, setRequestedCurrency] = useState<string | null>(null);
  const [openDeal, setOpenDeal] = useState<Id<"opportunities"> | null>(null);

  const { plan, loaded } = range;
  const common = { page: "attribution" as const, plan };
  const lanesReport = useAnalyticsReport({
    ...common,
    reportId: "attribution.lanes",
    live: api.reports.attribution.getLanes,
    liveArgs: loaded ? range.window : "skip",
    todayArgs: loaded ? range.todayWindow : "skip",
    merge: mergeAttributionLanes,
  });
  const pathsReport = useAnalyticsReport({
    ...common,
    reportId: "attribution.paths",
    live: api.reports.attribution.getPaths,
    liveArgs: loaded ? range.window : "skip",
    todayArgs: loaded ? range.todayWindow : "skip",
    merge: mergeAttributionPaths,
  });
  const lanes = useKeptWhileLoading(lanesReport.data, range.phrase);
  const paths = useKeptWhileLoading(pathsReport.data, range.phrase);

  const currencies = lanes.data?.currencies ?? [];
  const currency = shownCurrency(requestedCurrency, currencies, pickMainCurrency(attributionCurrencyWeights(lanes.data)));
  const views = lanes.data ? laneViews(lanes.data, currency) : undefined;
  const total = inCurrency(lanes.data?.totals, currency);
  const others = (lanes.data?.totals ?? []).filter((row) => row.currency !== currency && row.cashMinor !== 0);
  const freshness = freshnessSummary([lanesReport.freshness, pathsReport.freshness], now);
  const creditsExport = useRowsExport({
    kind: "credits",
    label: "Credits · CSV",
    page: "attribution",
    startDate: range.dates.startBusinessDate,
    endDate: range.dates.endBusinessDateInclusive,
  });

  return (
    <div className={REPORT_PAGE}>
      <ReportBand
        title="Attribution"
        range={range.words}
        freshness={lanesReport.data !== undefined ? freshness : null}
        dayLine={range.dayLine}
        sentence="Cash by payment date, credit as of each payment"
        actions={
          <>
            <ReportRangePicker range={range} />
            <CurrencySelect currencies={currencies} value={currency} onChange={setRequestedCurrency} />
            <ReportExportMenu
              page="attribution"
              startDate={range.dates.startBusinessDate}
              endDate={range.dates.endBusinessDateInclusive}
              extra={[creditsExport]}
              buildDocument={() =>
                lanes.data && paths.data
                  ? buildAttributionDocument({
                      words: range.words,
                      dayLine: range.dayLine,
                      generatedAt: Date.now(),
                      lanes: lanes.data,
                      paths: paths.data,
                    })
                  : null
              }
            />
          </>
        }
        figures={
          <ReportFigures columns="grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-6" reloading={lanes.reloading}>
            <FigureZone
              label={REPORT_TERMS.cash.label}
              help={termHelp("cash")}
              figureClassName="text-primary"
              figure={
                lanes.data ? (
                  <>
                    {formatMoney(total?.cashMinor ?? 0, currency)}
                    {others.map((row) => (
                      <OtherFigure key={row.currency}>{formatMoney(row.cashMinor, row.currency)}</OtherFigure>
                    ))}
                  </>
                ) : undefined
              }
              proof={
                lanes.data
                  ? total && total.payments > 0
                    ? `${formatCount(total.payments)} payment${total.payments === 1 ? "" : "s"} in ${currency}`
                    : "No payments yet"
                  : undefined
              }
            />
            {views
              ? views.map((view) => (
                  <FigureZone
                    key={view.role}
                    label={ROLE_LABELS[view.role]}
                    help={termHelp("attributionCoverage")}
                    figure={formatCoverage(view.coverage)}
                    proof={view.totalMinor > 0 ? coverageProof(view, currency) : "No cash to cover"}
                  />
                ))
              : ROLE_ORDER.map((role) => <FigureZone key={role} label={ROLE_LABELS[role]} figure={undefined} />)}
          </ReportFigures>
        }
      />
      <ReportRangeMessage range={range} />
      <AnalyticsFreshnessAlert summary={freshness} />

      <LanesCard
        views={views}
        currency={currency}
        isTruncated={lanes.data?.isTruncated ?? false}
        reloading={lanes.reloading}
        phrase={lanes.phrase}
      />

      <div className={REPORT_PAIR}>
        <ResponsibleCard
          rows={lanes.data ? responsibleRows(lanes.data, currency) : undefined}
          currency={currency}
          reloading={lanes.reloading}
          phrase={lanes.phrase}
          onOpenDeal={setOpenDeal}
        />
        <PathsCard
          rows={paths.data ? pathRows(paths.data, currency) : undefined}
          currency={currency}
          isTruncated={paths.data?.isTruncated ?? false}
          reloading={paths.reloading}
          phrase={paths.phrase}
          onOpenDeal={setOpenDeal}
        />
      </div>

      <DealChainSheet opportunityId={openDeal} onClose={() => setOpenDeal(null)} />
    </div>
  );
}
