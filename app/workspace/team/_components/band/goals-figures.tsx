"use client";

import { Component, type ReactNode } from "react";
import { SHORT_DAY } from "../schedule-editor";
import { listDays } from "../schedules/schedule-model";
import { qualifiedGroup } from "../goals/goal-model";
import { useGoalsData } from "../goals/use-goals-data";
import { BandFigure, BandFigures, BandFiguresPlaceholder } from "./band-figure";

// Team › Goals: the band's figures and its one lime action. The band
// (../team-band.tsx) renders these on the Goals tab.

/** The qualified-leads goal, the teams' booked goals, and the days the qualified goal counts. */
export function GoalsFigures() {
  return (
    <QuietBoundary>
      <Figures />
    </QuietBoundary>
  );
}

function Figures() {
  const { directory, qualifications } = useGoalsData();
  if (!directory || !qualifications) return <BandFiguresPlaceholder />;
  const goal = qualifications.goal.dailyQuota;
  const active = directory.teams.filter((team) => team.isActive);
  const withGoal = active.filter((team) => team.bookingDailyQuota !== null);
  const bookedSum = withGoal.reduce((sum, team) => sum + (team.bookingDailyQuota ?? 0), 0);
  const group = qualifiedGroup(directory);
  return (
    <BandFigures>
      <BandFigure
        label="Qualified a day"
        tip="Qualified leads the whole workspace should log each day it counts. Qualifications draws its goal bar from it."
        value={goal ?? "—"}
        caption={goal === null ? "No goal" : "whole workspace"}
        href="/workspace/team/goals#qualified"
      />
      <BandFigure
        label="Booked a day"
        tip="Every active team’s booked-calls goal, added up. Booked Calls draws each team’s goal ring from its own."
        value={withGoal.length ? bookedSum : "—"}
        caption={`${withGoal.length} of ${active.length} ${active.length === 1 ? "team has" : "teams have"} one`}
        href="/workspace/team/goals#booked"
      />
      <BandFigure
        label="Days counted"
        tip="Weekdays the qualified-leads goal counts: the days some Slack qualifier works. Until one has hours, every day counts."
        value={group.counted.length}
        of={7}
        caption={
          group.noHours
            ? "nobody has hours yet"
            : group.skipped.length
              ? `qualified goal · skips ${listDays(group.skipped, SHORT_DAY)}`
              : "qualified goal, a week"
        }
      />
    </BandFigures>
  );
}

/** The Goals tab has no lime action: each goal saves as it changes. */
export function GoalsAction() {
  return null;
}

/** The band must not fail with a figure: a read that throws shows nothing. */
class QuietBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
