import { v } from "convex/values";
import { businessDateToUtcStart } from "../reporting/lib/hondurasBusinessTime";

export const weekdayValidator = v.union(
  v.literal("monday"),
  v.literal("tuesday"),
  v.literal("wednesday"),
  v.literal("thursday"),
  v.literal("friday"),
  v.literal("saturday"),
  v.literal("sunday"),
);

export const weekdays = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type Weekday = (typeof weekdays)[number];

const weekdaysByUtcDay: readonly Weekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export function weekdayForBusinessDate(dayKey: string): Weekday {
  businessDateToUtcStart(dayKey);
  const date = new Date(`${dayKey}T12:00:00.000Z`);
  const weekday = weekdaysByUtcDay[date.getUTCDay()];
  if (!weekday) {
    throw new Error("Invalid business date weekday");
  }
  return weekday;
}

// --- Dated schedules -------------------------------------------------------
//
// A schedule row holds one weekday's hours for one person in one role. A
// change applies from the business date it was saved on (`effectiveFrom`):
// earlier days keep the hours they had, so a report's past per-hour figures
// never move. Rows saved before schedules were dated have no `effectiveFrom`
// and apply from the beginning. Each weekday is dated on its own: a save
// writes rows only for the weekdays that changed.

export type WeekHours = Record<Weekday, number>;

export type DatedScheduleRow = {
  weekday: Weekday;
  scheduledHours: number;
  effectiveFrom?: string;
};

function startedBy(row: DatedScheduleRow, dayKey: string) {
  return row.effectiveFrom === undefined || row.effectiveFrom <= dayKey;
}

/** The row in force for `weekday` on business date `dayKey`: the latest one that had started by then. */
export function rowInForce<Row extends DatedScheduleRow>(
  rows: readonly Row[],
  weekday: Weekday,
  dayKey: string,
): Row | null {
  let found: Row | null = null;
  for (const row of rows) {
    if (row.weekday !== weekday || !startedBy(row, dayKey)) continue;
    // An undated row ("" here) loses to any dated one.
    if (found === null || (found.effectiveFrom ?? "") < (row.effectiveFrom ?? "")) found = row;
  }
  return found;
}

/** The rows in force on `dayKey`, at most one per weekday: the week as it stood that day. */
export function rowsInForce<Row extends DatedScheduleRow>(rows: readonly Row[], dayKey: string): Row[] {
  return weekdays.flatMap((weekday) => {
    const row = rowInForce(rows, weekday, dayKey);
    return row ? [row] : [];
  });
}

/** One person's hours in one role on `dayKey`, under the schedule in force that day. 0 when none. */
export function hoursOn(rows: readonly DatedScheduleRow[], dayKey: string): number {
  return rowInForce(rows, weekdayForBusinessDate(dayKey), dayKey)?.scheduledHours ?? 0;
}

/** Hours summed over business dates, each under the schedule in force that day. */
export function hoursOverDays(rows: readonly DatedScheduleRow[], dayKeys: readonly string[]): number {
  return dayKeys.reduce((sum, dayKey) => sum + hoursOn(rows, dayKey), 0);
}

/** The week in force on `dayKey`, or null when no schedule had started by then. */
export function weekOn(rows: readonly DatedScheduleRow[], dayKey: string): WeekHours | null {
  let started = false;
  const week = {} as WeekHours;
  for (const weekday of weekdays) {
    const row = rowInForce(rows, weekday, dayKey);
    if (row) started = true;
    week[weekday] = row?.scheduledHours ?? 0;
  }
  return started ? week : null;
}

/** When the week in force on `dayKey` last changed; null when it dates from before schedules were dated. */
export function weekChangedOn(rows: readonly DatedScheduleRow[], dayKey: string): string | null {
  let latest: string | null = null;
  for (const weekday of weekdays) {
    const from = rowInForce(rows, weekday, dayKey)?.effectiveFrom;
    if (from !== undefined && (latest === null || from > latest)) latest = from;
  }
  return latest;
}

export function weekHoursTotal(week: WeekHours): number {
  return weekdays.reduce((sum, weekday) => sum + week[weekday], 0);
}

/**
 * Whether a goal counts `dayKey` for a group (the Slack qualifiers, or one DM
 * team's closers), given each member's schedule rows. A day counts when
 * someone in the group is scheduled to work it. Until anyone in the group has
 * hours in force (an empty or all-zero week counts as none), every day counts,
 * as goals did before schedules decided it.
 */
export function goalCountsDay(group: ReadonlyArray<readonly DatedScheduleRow[]>, dayKey: string): boolean {
  const weekday = weekdayForBusinessDate(dayKey);
  let anyoneScheduled = false;
  for (const rows of group) {
    const week = weekOn(rows, dayKey);
    if (week === null || weekHoursTotal(week) === 0) continue;
    if (week[weekday] > 0) return true;
    anyoneScheduled = true;
  }
  return !anyoneScheduled;
}

/** How many of `dayKeys` a goal counts for the group. */
export function goalDayCount(group: ReadonlyArray<readonly DatedScheduleRow[]>, dayKeys: readonly string[]): number {
  return dayKeys.reduce((count, dayKey) => count + (goalCountsDay(group, dayKey) ? 1 : 0), 0);
}
