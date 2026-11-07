"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { formatHours, weekTotal } from "../schedule-editor";
import { scheduleRows, uncoveredDays } from "../schedules/schedule-model";
import { BandFigure, BandFigures, BandFiguresPlaceholder } from "./band-figure";

// Team › Schedules: the band's figures and its one lime action. The band
// (../team-band.tsx) renders these on the Schedules tab.

/** Hours a week, roles on a schedule, roles with none, and days goals skip. */
export function SchedulesFigures() {
  const directory = useQuery(api.team.directory.getDirectory, {});
  if (!directory) return <BandFiguresPlaceholder />;
  const active = scheduleRows(directory).filter((row) => row.active);
  const scheduled = active.filter((row) => row.scheduled);
  const hours = scheduled.reduce((sum, row) => sum + weekTotal(row.week), 0);
  const missing = active.length - scheduled.length;
  const uncovered = uncoveredDays(active, directory.teams);
  return (
    <BandFigures>
      <BandFigure
        label="Hours a week"
        tip="Every active role’s week in force today, added up: lead gen, Slack and DM closers. Someone with two roles counts both weeks."
        value={formatHours(hours)}
        unit="h"
        caption="all roles"
      />
      <BandFigure
        label="On a schedule"
        tip="Active role records with hours in their week. Each role keeps its own week, so someone with two roles counts twice."
        value={scheduled.length}
        of={active.length}
        caption="roles with hours"
      />
      <BandFigure
        label="No schedule"
        tip="Active role records with no hours. Their per-hour figures stay blank on Lead Gen, Qualifications and Booked Calls."
        value={missing}
        caption={missing ? "Show them" : "every role has hours"}
        href={missing ? "/workspace/team/schedules?show=missing" : undefined}
        tone={missing ? "warning" : "default"}
      />
      <BandFigure
        label="Days uncovered"
        tip="Weekdays nobody works, counted per goal group: the Slack qualifiers, and each active DM team. A goal skips those days. Lead gen has no goal, so its empty days aren’t counted."
        value={uncovered}
        caption={uncovered === 1 ? "day a goal skips" : "days goals skip"}
      />
    </BandFigures>
  );
}

/** The Schedules tab has no lime action: a week changes from its row. */
export function SchedulesAction() {
  return null;
}
