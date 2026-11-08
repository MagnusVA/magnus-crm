"use client";

import Link from "next/link";
import { teamHref } from "@/app/workspace/operations/_components/team-links";
import { FigureZone, ReportFigures } from "../../_components/report-ui";
import type { SlackQualificationGranularity } from "./business-date-utils";

// The band's six figures in the book panel's grammar. A figure with no base
// reads a dash over a proof line that says why (The Worded Zero Rule).

type Totals = {
  businessDayCount: number;
  averagePerBusinessDay: number | null;
  dailyTeamQualificationGoal: number | null;
  expectedTeamQualified: number | null;
  teamGoalAttainment: number | null;
  underGoalPeriods: number;
  setterCount: number;
  qualificationEventCount: number;
  uniqueSlackOpportunityCount: number;
  createdOpportunityEvents: number;
  duplicatePendingEvents: number;
  alreadyBookedEvents: number;
};

const GOAL_LINK =
  "rounded-[3px] font-medium text-board-foreground underline decoration-board-foreground/40 underline-offset-[3px] outline-none hover:decoration-board-foreground focus-visible:ring-2 focus-visible:ring-ring";

const PERIOD_WORD: Record<SlackQualificationGranularity, string> = { day: "days", week: "weeks", month: "months" };

const count = (value: number) => value.toLocaleString();

function formatPercent(value: number | null): string {
  return value === null
    ? "—"
    : `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

export function SetterQualificationFigures({
  totals,
  filteredToSetter,
  granularity,
  reloading,
}: {
  totals: Totals | undefined;
  filteredToSetter: boolean;
  granularity: SlackQualificationGranularity;
  reloading: boolean;
}) {
  const noGoal = totals?.expectedTeamQualified === null;
  const goalLink = (
    <Link href={teamHref.goals("qualified")} className={GOAL_LINK}>
      Set in Team › Goals
    </Link>
  );

  return (
    <ReportFigures columns="grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-6" reloading={reloading}>
      <FigureZone
        label="Qualification events"
        figure={totals ? count(totals.qualificationEventCount) : undefined}
        proof={totals ? "Every Slack submission" : null}
      />
      <FigureZone
        label="Unique opportunities"
        figure={totals ? count(totals.uniqueSlackOpportunityCount) : undefined}
        proof={
          totals
            ? `${count(totals.createdOpportunityEvents)} created · ${count(totals.duplicatePendingEvents + totals.alreadyBookedEvents)} duplicate or booked`
            : null
        }
      />
      <FigureZone
        label="Per business day"
        figure={
          totals
            ? totals.averagePerBusinessDay === null
              ? "—"
              : totals.averagePerBusinessDay.toLocaleString(undefined, { maximumFractionDigits: 1 })
            : undefined
        }
        proof={
          totals
            ? `Events across ${count(totals.businessDayCount)} business day${totals.businessDayCount === 1 ? "" : "s"}`
            : null
        }
      />
      <FigureZone
        label="Team daily goal"
        figure={
          totals ? (totals.dailyTeamQualificationGoal === null ? "—" : count(totals.dailyTeamQualificationGoal)) : undefined
        }
        proof={
          totals ? (
            <>
              {totals.dailyTeamQualificationGoal === null ? "No goal set" : "One target for all setters"} · {goalLink}
            </>
          ) : null
        }
      />
      <FigureZone
        label="Team attainment"
        figure={totals ? formatPercent(totals.teamGoalAttainment) : undefined}
        proof={
          totals
            ? filteredToSetter
              ? "Shown for all setters only"
              : noGoal || totals.expectedTeamQualified === null
                ? "No team goal set"
                : `${count(totals.expectedTeamQualified)} events expected`
            : null
        }
      />
      <FigureZone
        label={`Under-goal ${PERIOD_WORD[granularity]}`}
        figure={totals ? (filteredToSetter || noGoal ? "—" : count(totals.underGoalPeriods)) : undefined}
        proof={
          totals
            ? filteredToSetter
              ? "Shown for all setters only"
              : noGoal
                ? "No team goal set"
                : `${count(totals.setterCount)} setters in view`
            : null
        }
      />
    </ReportFigures>
  );
}
