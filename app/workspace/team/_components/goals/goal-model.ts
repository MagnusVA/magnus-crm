import type { Id } from "@/convex/_generated/dataModel";
import type { Directory } from "@/convex/team/contracts";
import { WEEKDAYS, type Weekday, type WeekHours } from "../schedule-editor";
import { countedDays, goalGroups, hoursByDay, scheduleRows } from "../schedules/schedule-model";

// Team › Goals, as data: each goal's group (the Slack qualifiers; one DM
// team's active closers), the weekdays it counts, and an estimate of what the
// group's hours produce at the last 30 days' rate.

/** Goals take whole numbers up to this (setTeamDailyGoal, setTeamBookingQuota). */
export const MAX_DAILY_GOAL = 5000;

/** A business date ("2026-11-03") moved by whole days. */
export function addDays(dayKey: string, days: number) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

/** The last 30 finished business days: today is left out, so a half-done day doesn't drag the rate down. */
export function last30DaysRange(today: string) {
  return {
    kind: "custom" as const,
    startBusinessDate: addDays(today, -30),
    endBusinessDateInclusive: addDays(today, -1),
  };
}

export type GoalGroup = {
  /** Weeks in force today, one per active record in the group. */
  byDay: WeekHours;
  /** Records in the group (active), and how many have hours. */
  people: number;
  scheduled: number;
  counted: Weekday[];
  skipped: Weekday[];
  /** Nobody has hours: every day counts. */
  noHours: boolean;
};

function goalGroup(weeks: ReadonlyArray<{ week: WeekHours | null }>): GoalGroup {
  const counted = countedDays(weeks);
  const byDay = hoursByDay(weeks);
  const scheduled = weeks.filter((row) => row.week && WEEKDAYS.some((day) => row.week![day] > 0)).length;
  return {
    byDay,
    people: weeks.length,
    scheduled,
    counted,
    skipped: WEEKDAYS.filter((day) => !counted.includes(day)),
    noHours: scheduled === 0,
  };
}

/** The qualified-leads group: every Slack qualifier not deleted in Slack. */
export function qualifiedGroup(directory: Directory) {
  const rows = scheduleRows(directory).filter((row) => row.role === "slack" && row.active);
  return goalGroup(rows);
}

/** Each active team's booked-calls group: its active DM closers. */
export function bookedGroups(directory: Directory) {
  const rows = scheduleRows(directory);
  const byTeam = new Map(
    goalGroups(rows, directory.teams)
      .filter((group) => group.kind === "dm_team" && group.teamId)
      .map((group) => [group.teamId!, group.rows]),
  );
  return directory.teams
    .filter((team) => team.isActive)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
    .map((team) => ({ team, group: goalGroup(byTeam.get(team.teamId) ?? []) }));
}

/** Results over hours in the last 30 days: the rate an estimate multiplies by. */
export type Rate = { results: number; hours: number };

export type Estimate =
  | {
      ok: true;
      perHour: number;
      /** Per weekday: the estimate on a counted day, null on a skipped one. */
      byDay: Record<Weekday, number | null>;
      /** On an average counted day. */
      perDay: number;
      /** The group's hours on an average counted day. */
      hoursPerDay: number;
    }
  | { ok: false; reason: "no_hours_now" | "no_hours_before" | "no_results" | "capped" | "loading" };

/**
 * What the group's weeks produce at the last 30 days' rate: rate × the
 * group's hours on each counted weekday, and on an average counted day.
 */
export function estimate(group: GoalGroup, rate: Rate | "capped" | undefined): Estimate {
  if (rate === undefined) return { ok: false, reason: "loading" };
  if (rate === "capped") return { ok: false, reason: "capped" };
  if (group.noHours) return { ok: false, reason: "no_hours_now" };
  if (rate.hours <= 0) return { ok: false, reason: "no_hours_before" };
  if (rate.results <= 0) return { ok: false, reason: "no_results" };
  const perHour = rate.results / rate.hours;
  const byDay = Object.fromEntries(
    WEEKDAYS.map((day) => [day, group.counted.includes(day) ? perHour * group.byDay[day] : null]),
  ) as Record<Weekday, number | null>;
  const hoursPerDay =
    group.counted.reduce((sum, day) => sum + group.byDay[day], 0) / Math.max(group.counted.length, 1);
  return { ok: true, perHour, byDay, perDay: perHour * hoursPerDay, hoursPerDay };
}

/** Per-hour rates by DM team from the Booked Calls dashboard's closer rows. */
export function bookedRatesByTeam(
  directory: Directory,
  closers: ReadonlyArray<{ key: string; booked: number; scheduledHours: number | null }>,
) {
  const teamOf = new Map<string, Id<"attributionTeams">>();
  for (const member of directory.members) {
    for (const closer of member.dmClosers) teamOf.set(closer.dmCloserId, closer.teamId);
  }
  const rates = new Map<Id<"attributionTeams">, Rate>();
  for (const closer of closers) {
    const teamId = teamOf.get(closer.key);
    // Closers with no hours have no rate: their bookings would inflate it.
    if (!teamId || !closer.scheduledHours) continue;
    const rate = rates.get(teamId) ?? { results: 0, hours: 0 };
    rate.results += closer.booked;
    rate.hours += closer.scheduledHours;
    rates.set(teamId, rate);
  }
  return rates;
}

/** The qualified-leads rate from the Qualifications dashboard's opener rows. */
export function qualifiedRate(openers: ReadonlyArray<{ qualified: number; scheduledHours: number | null }>): Rate {
  let results = 0;
  let hours = 0;
  for (const opener of openers) {
    if (!opener.scheduledHours) continue;
    results += opener.qualified;
    hours += opener.scheduledHours;
  }
  return { results, hours };
}

/** "≈ 53", "≈ 4.5", "< 0.1": estimates read as whole numbers once they pass 10. */
export function formatEstimate(value: number) {
  if (value > 0 && value < 0.05) return "< 0.1";
  if (value >= 10) return `≈ ${Math.round(value)}`;
  return `≈ ${Math.round(value * 10) / 10}`;
}

export function formatRate(value: number) {
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}
