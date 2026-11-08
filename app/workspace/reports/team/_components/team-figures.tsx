"use client";

import { SHOW_RATE_HELP } from "@/app/workspace/_components/results-recorded";
import { FigureUnit, FigureZone, ReportFigures } from "../../_components/report-ui";
import type { ActionsPerCloserMetrics, DerivedOutcomes, TeamPerformanceMetrics } from "./team-report-types";
import {
  TEAM_CLOSE_RATE_HELP,
  cohortCloseRate,
  dealsWonWords,
  formatCount,
  formatMoney,
  formatRate,
  plural,
  resultsWords,
} from "./team-report-formatters";

// The band's seven figures in the book panel's grammar. Each zone fills in
// as its own report arrives; a figure with no base reads a dash over a proof
// line that says why (DESIGN.md, The Worded Zero Rule).

export function TeamFigures({
  metrics,
  derived,
  actions,
  rangePhrase,
  reloading,
}: {
  metrics: TeamPerformanceMetrics | undefined;
  derived: DerivedOutcomes | undefined;
  actions: ActionsPerCloserMetrics | undefined;
  /** "today", "this week", "in this range". */
  rangePhrase: string;
  reloading: boolean;
}) {
  const totals = metrics?.teamTotals;
  const booked = totals ? totals.newBookedCalls + totals.followUpBookedCalls : 0;
  const closeRate = totals
    ? cohortCloseRate({ closeRate: totals.overallCloseRate, cohortDeals: totals.cohortDeals, wonDeals: totals.wonDeals })
    : null;

  return (
    <ReportFigures columns="grid-cols-2 @3xl:grid-cols-4 @5xl:grid-cols-7" reloading={reloading}>
      <FigureZone
        label="Booked"
        figure={totals ? formatCount(booked) : undefined}
        proof={
          totals
            ? booked === 0
              ? `No calls booked ${rangePhrase}`
              : `${formatCount(totals.newBookedCalls)} new · ${formatCount(totals.followUpBookedCalls)} follow-up`
            : null
        }
      />
      <FigureZone
        label="Show rate"
        help={SHOW_RATE_HELP}
        figure={totals ? formatRate(totals.overallShowUpRate) : undefined}
        proof={totals ? resultsWords(totals, metrics?.attendanceCountsPartial) : null}
      />
      <FigureZone
        label="Revenue"
        figure={totals ? formatMoney(totals.totalRevenueMinor) : undefined}
        figureClassName="text-primary"
        proof={
          totals
            ? `${totals.totalSales === 0 ? "No payments yet" : plural(totals.totalSales, "payment sale")}${metrics?.isPaymentDataTruncated ? " · approximate" : ""}`
            : null
        }
      />
      <FigureZone
        label="Close rate"
        help={TEAM_CLOSE_RATE_HELP}
        figure={closeRate ? formatRate(closeRate.rate) : undefined}
        proof={closeRate ? (dealsWonWords(closeRate) ?? "Too many held calls to count; narrow the range") : null}
      />
      <FigureZone
        label="Lost deals"
        figure={derived ? formatCount(derived.lostDeals) : undefined}
        proof={derived ? (derived.lostDeals === 0 ? `No deals lost ${rangePhrase}` : "Deals that ended lost") : null}
      />
      <FigureZone
        label="Rebook rate"
        help="Rescheduled calls ÷ (canceled + no-show)."
        figure={derived ? formatRate(derived.rebookRate) : undefined}
        proof={
          derived
            ? derived.rebookDenominator === 0
              ? "No canceled or missed calls"
              : `${formatCount(derived.rebookNumerator)} rebooked of ${formatCount(derived.rebookDenominator)} missed`
            : null
        }
      />
      <FigureZone
        label="Actions per closer"
        help="Closer actions ÷ closers who acted ÷ days in the range."
        className="col-span-2 @5xl:col-span-1"
        figure={
          actions ? (
            actions.actionsPerCloserPerDay === null ? (
              "—"
            ) : (
              <>
                {actions.actionsPerCloserPerDay.toFixed(1)}
                <FigureUnit>/day</FigureUnit>
              </>
            )
          ) : undefined
        }
        proof={
          actions
            ? actions.distinctCloserActors === 0
              ? `No closer actions ${rangePhrase}`
              : `${plural(actions.distinctCloserActors, "active closer")} · ${plural(actions.daySpanDays, "day")}${actions.isTruncated ? " · first 5,000 actions" : ""}`
            : null
        }
      />
    </ReportFigures>
  );
}
