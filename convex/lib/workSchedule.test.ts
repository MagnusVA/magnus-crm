import { describe, expect, it } from "vitest";
import {
  goalCountsDay,
  goalDayCount,
  hoursOn,
  hoursOverDays,
  weekChangedOn,
  weekOn,
  type DatedScheduleRow,
} from "./workSchedule";

// 2026-11-02 is a Monday.
const MON = "2026-11-02";
const TUE = "2026-11-03";
const SUN = "2026-11-08";
const NEXT_MON = "2026-11-09";

function week(hours: number, days = ["monday", "tuesday", "wednesday", "thursday", "friday"], effectiveFrom?: string) {
  return (["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const).map(
    (weekday): DatedScheduleRow => ({ weekday, scheduledHours: days.includes(weekday) ? hours : 0, ...(effectiveFrom ? { effectiveFrom } : {}) }),
  );
}

describe("dated schedules", () => {
  it("applies undated rows from the beginning", () => {
    const rows = week(7);
    expect(hoursOn(rows, "2020-01-06")).toBe(7);
    expect(hoursOn(rows, SUN)).toBe(0);
    expect(weekChangedOn(rows, MON)).toBeNull();
  });

  it("applies a change from its date on and keeps earlier days", () => {
    const rows = [...week(7), { weekday: "monday" as const, scheduledHours: 4, effectiveFrom: NEXT_MON }];
    expect(hoursOn(rows, MON)).toBe(7);
    expect(hoursOn(rows, NEXT_MON)).toBe(4);
    expect(hoursOverDays(rows, [MON, TUE, NEXT_MON])).toBe(7 + 7 + 4);
    expect(weekOn(rows, MON)?.monday).toBe(7);
    expect(weekOn(rows, NEXT_MON)?.monday).toBe(4);
    expect(weekOn(rows, NEXT_MON)?.tuesday).toBe(7);
    expect(weekChangedOn(rows, NEXT_MON)).toBe(NEXT_MON);
  });

  it("has no week before the first dated row", () => {
    const rows = week(8, undefined, TUE);
    expect(weekOn(rows, MON)).toBeNull();
    expect(hoursOn(rows, MON)).toBe(0);
    expect(hoursOn(rows, TUE)).toBe(8);
  });

  it("picks the latest of several dated rows", () => {
    const rows: DatedScheduleRow[] = [
      { weekday: "tuesday", scheduledHours: 2, effectiveFrom: "2026-10-01" },
      { weekday: "tuesday", scheduledHours: 5 },
      { weekday: "tuesday", scheduledHours: 3, effectiveFrom: "2026-10-20" },
    ];
    expect(hoursOn(rows, "2026-09-29")).toBe(5);
    expect(hoursOn(rows, "2026-10-06")).toBe(2);
    expect(hoursOn(rows, TUE)).toBe(3);
  });
});

describe("goal days", () => {
  it("counts every day until anyone in the group has hours", () => {
    expect(goalCountsDay([], SUN)).toBe(true);
    expect(goalCountsDay([week(0)], SUN)).toBe(true);
  });

  it("skips days nobody in the group works", () => {
    const group = [week(7), week(4, ["monday", "saturday"])];
    const days = [MON, TUE, "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", SUN];
    expect(goalCountsDay(group, SUN)).toBe(false);
    expect(goalCountsDay(group, "2026-11-07")).toBe(true);
    expect(goalDayCount(group, days)).toBe(6);
  });

  it("uses the schedules in force on each day", () => {
    const group = [week(7, undefined, NEXT_MON)];
    expect(goalCountsDay(group, SUN)).toBe(true);
    expect(goalCountsDay(group, "2026-11-15")).toBe(false);
  });
});
