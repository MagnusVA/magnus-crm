"use client";

import { useReportViewed } from "../../_components/use-report-page";
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  mergeAnswers,
  mergeCash,
  mergeFollowThrough,
  mergeFunnel,
  mergeOrigins,
} from "@/convex/analytics/merge/scorecard";
import {
  AnalyticsFreshnessAlert,
  AnalyticsFreshnessLine,
  freshnessSummary,
} from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { REPORT_TERMS, termHelp } from "@/lib/reporting/definitions";
import { currentAnswers } from "@/lib/reporting/export";
import { ReportExportMenu } from "../../_components/report-export-menu";
import { ReportProgramFilter } from "../../_components/report-program-filter";
import {
  FigureZone,
  OtherFigure,
  REPORT_PAGE,
  REPORT_PAIR,
  ReportBand,
  ReportFigures,
} from "../../_components/report-ui";
import { ReportRangeMessage, ReportRangePicker, useReportRange } from "../../_components/use-report-range";
import { useTeamMembers } from "../../log/_components/use-team-members";
import { AnswersCard, defaultAnswerField } from "./answers-card";
import { CurrencySelect } from "./report-currency";
import { useRowsExport } from "../../_components/report-export-menu";
import {
  formatCount,
  formatMoney,
  inCurrency,
  listCurrencies,
  pickMainCurrency,
  resolvedReportRange,
  shownCurrency,
} from "./report-money";
import {
  CashCard,
  FollowThroughCard,
  FunnelCard,
  OriginsCard,
  ProgramsTableCard,
  WeeksCard,
} from "./scorecard-cards";
import { buildScorecardDocument, scorecardCurrencyWeights } from "./scorecard-shape";

// The Scorecard (docs/reviews/reports-overhaul.html §08): the period on one
// page, from people in conversation to cash. Every card reads the range
// through useAnalyticsReport, so the days before today come from ClickHouse
// and today from Convex, merged on the page.

export function ScorecardPageClient() {
  usePageTitle("Scorecard");
  useReportViewed("scorecard");
  const now = useNow();
  const range = useReportRange();
  const [programId, setProgramId] = useState<Id<"tenantPrograms"> | undefined>();
  const [requestedCurrency, setRequestedCurrency] = useState<string | null>(null);
  const [pickedField, setPickedField] = useState<string | null>(null);
  const catalog = useQuery(api.reports.formFields.getFieldCatalog, {});
  const programs = useQuery(api.tenantPrograms.queries.listPrograms, { includeArchived: true });
  const team = useTeamMembers();
  const fieldKey = pickedField ?? defaultAnswerField(catalog);

  const { plan, loaded, setting } = range;
  const whole = loaded ? resolvedReportRange(range.dayKeys, range.window, setting) : null;
  const today = loaded ? resolvedReportRange(range.todayDayKeys, range.todayWindow, setting) : null;
  const program = programId ? { programId } : {};
  const args = (resolved: typeof whole) => (resolved ? { range: resolved, ...program } : "skip" as const);
  const common = { page: "scorecard" as const, plan, filters: { programId } };

  const funnelReport = useAnalyticsReport({
    ...common,
    reportId: "scorecard.funnel",
    live: api.reports.scorecard.funnel,
    liveArgs: args(whole),
    todayArgs: args(today),
    merge: mergeFunnel,
  });
  const cashReport = useAnalyticsReport({
    ...common,
    reportId: "scorecard.cash",
    live: api.reports.scorecard.cash,
    liveArgs: args(whole),
    todayArgs: args(today),
    merge: mergeCash,
  });
  const followReport = useAnalyticsReport({
    ...common,
    reportId: "scorecard.follow_through",
    live: api.reports.scorecard.followThrough,
    liveArgs: args(whole),
    todayArgs: args(today),
    merge: mergeFollowThrough,
  });
  const originsReport = useAnalyticsReport({
    ...common,
    reportId: "scorecard.origins",
    live: api.reports.scorecard.origins,
    liveArgs: args(whole),
    todayArgs: args(today),
    merge: mergeOrigins,
  });
  const answerArgs = (resolved: typeof whole) =>
    resolved && fieldKey ? { range: resolved, ...program, fieldKey } : ("skip" as const);
  const answersReport = useAnalyticsReport({
    ...common,
    filters: { programId, fieldKey: fieldKey ?? undefined },
    reportId: "scorecard.answers",
    live: api.reports.scorecard.answers,
    liveArgs: answerArgs(whole),
    todayArgs: answerArgs(today),
    merge: mergeAnswers,
  });

  // Each card keeps its last answer, dimmed, while a new range or filter
  // loads (DESIGN.md, Kept Data While Reloading).
  const funnel = useKeptWhileLoading(funnelReport.data, range.phrase);
  const cash = useKeptWhileLoading(cashReport.data, range.phrase);
  const follow = useKeptWhileLoading(followReport.data, range.phrase);
  const origins = useKeptWhileLoading(originsReport.data, range.phrase);
  const answers = useKeptWhileLoading(answersReport.data, range.phrase);

  const currencies = listCurrencies(
    funnel.data?.activity.cash,
    cash.data?.currencies,
    origins.data?.origins.flatMap((origin) => origin.cash),
  );
  const currency = shownCurrency(
    requestedCurrency,
    currencies,
    pickMainCurrency(scorecardCurrencyWeights(cash.data, funnel.data, origins.data)),
  );
  const cashEntry = inCurrency(cash.data?.currencies, currency);
  const activityCash = funnel.data?.activity.cash ?? [];
  const shownCash = inCurrency(activityCash, currency);
  const otherCash = activityCash.filter((row) => row.currency !== currency && row.cashMinor !== 0);

  const freshness = freshnessSummary(
    [funnelReport.freshness, cashReport.freshness, followReport.freshness, originsReport.freshness],
    now,
  );
  const programName = programId ? (programs?.find((row) => row._id === programId)?.name ?? "One program") : null;
  const paymentsExport = useRowsExport("payments", "scorecard", range.dates.startBusinessDate, range.dates.endBusinessDateInclusive, programId ? { programId } : {});
  const f = funnel.data;

  return (
    <div className={REPORT_PAGE}>
      <ReportBand
        title="Scorecard"
        range={range.words}
        freshness={funnelReport.data !== undefined ? freshness : null}
        dayLine={range.dayLine}
        actions={
          <>
            <ReportRangePicker range={range} />
            <CurrencySelect currencies={currencies} value={currency} onChange={setRequestedCurrency} />
            <ReportExportMenu
              page="scorecard"
              startDate={range.dates.startBusinessDate}
              endDate={range.dates.endBusinessDateInclusive}
              extra={[paymentsExport]}
              buildDocument={() => {
                // Only the current range's answers: kept ones belong to the
                // range or program the page showed before. The answers table
                // is optional, so kept answers leave it out.
                const current = currentAnswers({ funnel, cash, follow, origins });
                return current
                  ? buildScorecardDocument({
                      words: range.words,
                      dayLine: range.dayLine,
                      programName,
                      generatedAt: Date.now(),
                      funnel: current.funnel,
                      cash: current.cash,
                      followThrough: current.follow,
                      origins: current.origins,
                      answers: answers.reloading ? null : (answers.data ?? null),
                    })
                  : null;
              }}
            />
          </>
        }
        figures={
          <ReportFigures columns="grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-[repeat(5,minmax(0,1fr))_1.4fr]" reloading={funnel.reloading}>
            <FigureZone
              label="In conversation"
              help="People who entered In conversation in the range: the start of the funnel."
              figure={f ? formatCount(f.stages.in_conversation) : undefined}
              proof={f ? `${formatCount(f.stages.prospect)} new prospect${f.stages.prospect === 1 ? "" : "s"}` : undefined}
            />
            <FigureZone
              label="Qualified"
              help="People who entered Qualified in the range."
              figure={f ? formatCount(f.stages.qualified) : undefined}
              proof="people entering Qualified"
            />
            <FigureZone
              label={REPORT_TERMS.bookingsMade.label}
              help={termHelp("bookingsMade")}
              figure={f ? formatCount(f.activity.bookingsMade) : undefined}
              proof="moves and rebooks left out"
            />
            <FigureZone
              label="Calls held"
              help="Calls scheduled in the range that were held."
              figure={f ? formatCount(f.activity.callsHeld) : undefined}
              proof={f ? `${formatCount(f.stages.showed)} people showed for the first time` : undefined}
            />
            <FigureZone
              label={REPORT_TERMS.dealsWon.label}
              help={termHelp("dealsWon")}
              figure={f ? formatCount(f.activity.dealsWon) : undefined}
              proof="first payment in the range"
            />
            <FigureZone
              label={REPORT_TERMS.cash.label}
              help={termHelp("cash")}
              figureClassName="text-primary"
              figure={
                f ? (
                  <>
                    {formatMoney(shownCash?.cashMinor ?? 0, currency)}
                    {otherCash.map((row) => (
                      <OtherFigure key={row.currency}>{formatMoney(row.cashMinor, row.currency)}</OtherFigure>
                    ))}
                  </>
                ) : undefined
              }
              proof={
                f
                  ? shownCash && shownCash.cashMinor !== 0
                    ? `${REPORT_TERMS.finalCash.label} ${formatMoney(shownCash.finalMinor, currency)}`
                    : "No payments yet"
                  : undefined
              }
            />
          </ReportFigures>
        }
        filters={<ReportProgramFilter label="Program" value={programId} onChange={setProgramId} />}
      />
      <ReportRangeMessage range={range} />
      <AnalyticsFreshnessAlert summary={freshness} />

      <div className={REPORT_PAIR}>
        <FunnelCard
          funnel={funnel.data}
          reloading={funnel.reloading}
          phrase={funnel.phrase}
          programSelected={programId !== undefined}
        />
        <CashCard
          entry={cashEntry}
          loaded={cash.data !== undefined}
          currency={currency}
          reloading={cash.reloading}
          phrase={cash.phrase}
        />
      </div>

      <WeeksCard funnel={funnel.data} currency={currency} reloading={funnel.reloading} phrase={funnel.phrase} />

      <div className={REPORT_PAIR}>
        <ProgramsTableCard
          entry={cashEntry}
          loaded={cash.data !== undefined}
          currency={currency}
          reloading={cash.reloading}
          phrase={cash.phrase}
          programKey={programId ?? ""}
        />
        <OriginsCard data={origins.data} currency={currency} reloading={origins.reloading} phrase={origins.phrase} />
      </div>

      <div className={REPORT_PAIR}>
        <FollowThroughCard
          data={follow.data}
          reloading={follow.reloading}
          phrase={follow.phrase}
          programKey={programId ?? ""}
          memberFor={(userId) => team?.byUserId.get(userId)}
        />
        <AnswersCard
          catalog={catalog}
          fieldKey={fieldKey}
          onFieldKeyChange={setPickedField}
          programKey={programId ?? ""}
          answers={answers.data}
          source={answersReport.source}
          freshness={fieldKey ? <AnalyticsFreshnessLine items={[answersReport.freshness]} /> : null}
          reloading={answers.reloading}
          phrase={answers.phrase}
        />
      </div>
    </div>
  );
}
