import { describe, expect, it } from "vitest";
import {
  analyticsRangeIsEmpty,
  dashboardRangeFromToday,
  dashboardRangePlan,
  EmptyAnalyticsRangeError,
  reportRangePlan,
  reportWindowFromToday,
  resolveAnalyticsRange,
} from "./analyticsRange";

const tegucigalpa = { timeZone: "America/Tegucigalpa", dayStartHour: 1 };
// 2026-10-27 15:00 in Tegucigalpa (UTC-6).
const now = Date.UTC(2026, 9, 27, 21, 0);

describe("resolveAnalyticsRange", () => {
  it("resolves presets against the day containing now", () => {
    expect(resolveAnalyticsRange({ kind: "preset", preset: "this_month" }, tegucigalpa, now)).toMatchObject({
      startDate: "2026-10-01",
      endDateInclusive: "2026-10-27",
      fromMs: Date.UTC(2026, 9, 1, 7),
      toMs: Date.UTC(2026, 9, 28, 7),
    });
    expect(resolveAnalyticsRange({ kind: "preset", preset: "last_month" }, tegucigalpa, now)).toMatchObject({
      startDate: "2026-09-01",
      endDateInclusive: "2026-09-30",
    });
    expect(resolveAnalyticsRange({ kind: "preset", preset: "this_week" }, tegucigalpa, now).startDate).toBe("2026-10-26");
    expect(resolveAnalyticsRange({ kind: "preset", preset: "yesterday" }, tegucigalpa, now)).toMatchObject({
      startDate: "2026-10-26",
      endDateInclusive: "2026-10-26",
    });
    expect(resolveAnalyticsRange({ kind: "preset", preset: "last_90_days" }, tegucigalpa, now).startDate).toBe("2026-07-30");
  });

  it("counts 00:30 as the previous business day when days start at 01:00", () => {
    const halfPastMidnight = Date.UTC(2026, 9, 28, 6, 30);
    expect(resolveAnalyticsRange({ kind: "preset", preset: "yesterday" }, tegucigalpa, halfPastMidnight).startDate).toBe("2026-10-26");
  });

  it("rejects reversed, invalid and too-long ranges", () => {
    expect(() => resolveAnalyticsRange({ kind: "custom", startDate: "2026-10-02", endDateInclusive: "2026-10-01" }, tegucigalpa, now)).toThrow();
    expect(() => resolveAnalyticsRange({ kind: "custom", startDate: "2026-02-30", endDateInclusive: "2026-03-01" }, tegucigalpa, now)).toThrow();
    expect(() => resolveAnalyticsRange({ kind: "custom", startDate: "2020-01-01", endDateInclusive: "2026-01-01" }, tegucigalpa, now)).toThrow();
    expect(() => resolveAnalyticsRange({ kind: "preset", preset: "this_week" }, { timeZone: "Mars/Olympus", dayStartHour: 0 }, now)).toThrow();
  });
});

describe("presets through yesterday", () => {
  it("end the day before today and keep the preset's start", () => {
    expect(resolveAnalyticsRange({ kind: "preset", preset: "this_month", throughYesterday: true }, tegucigalpa, now)).toMatchObject({
      startDate: "2026-10-01",
      endDateInclusive: "2026-10-26",
      fromMs: Date.UTC(2026, 9, 1, 7),
      toMs: Date.UTC(2026, 9, 27, 7),
    });
    expect(resolveAnalyticsRange({ kind: "preset", preset: "last_90_days", throughYesterday: true }, tegucigalpa, now)).toMatchObject({
      startDate: "2026-07-30",
      endDateInclusive: "2026-10-26",
    });
  });

  it("have no days on the preset's first day", () => {
    // Monday 2026-10-26, 15:00 in Tegucigalpa.
    const monday = Date.UTC(2026, 9, 26, 21, 0);
    const thisWeek = { kind: "preset", preset: "this_week", throughYesterday: true } as const;
    expect(analyticsRangeIsEmpty(thisWeek, "2026-10-26")).toBe(true);
    expect(analyticsRangeIsEmpty(thisWeek, "2026-10-27")).toBe(false);
    expect(() => resolveAnalyticsRange(thisWeek, tegucigalpa, monday)).toThrow(EmptyAnalyticsRangeError);
  });
});

describe("reportRangePlan", () => {
  const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
  const at = new Date(2026, 9, 27, 15).getTime();

  it("reads Today, and ranges from today on, live", () => {
    expect(reportRangePlan({ startDate: local(2026, 10, 27), endDate: local(2026, 10, 28) }, at)).toEqual({ kind: "live" });
    expect(reportRangePlan({ startDate: local(2026, 10, 27), endDate: local(2026, 11, 3) }, at)).toEqual({ kind: "live" });
  });

  it("reads a range that ended before today from ClickHouse, presets kept", () => {
    expect(reportRangePlan({ startDate: local(2026, 9, 1), endDate: local(2026, 10, 1) }, at)).toEqual({
      kind: "warehouse",
      range: { kind: "preset", preset: "last_month" },
    });
    expect(reportRangePlan({ startDate: local(2026, 10, 3), endDate: local(2026, 10, 11) }, at)).toEqual({
      kind: "warehouse",
      range: { kind: "custom", startDate: "2026-10-03", endDateInclusive: "2026-10-10" },
    });
  });

  it("splits a range that includes today at the start of today", () => {
    expect(reportRangePlan({ startDate: local(2026, 10, 1), endDate: local(2026, 10, 28) }, at)).toEqual({
      kind: "split",
      history: { kind: "preset", preset: "this_month", throughYesterday: true },
      historyStartDate: "2026-10-01",
      historyEndDate: "2026-10-26",
    });
    expect(reportRangePlan({ startDate: local(2026, 10, 26), endDate: local(2026, 10, 28) }, at)).toMatchObject({
      kind: "split",
      history: { kind: "preset", preset: "this_week", throughYesterday: true },
    });
    // Dates that match no preset, here ending after today.
    expect(reportRangePlan({ startDate: local(2026, 10, 20), endDate: local(2026, 11, 3) }, at)).toEqual({
      kind: "split",
      history: { kind: "custom", startDate: "2026-10-20", endDateInclusive: "2026-10-26" },
      historyStartDate: "2026-10-20",
      historyEndDate: "2026-10-26",
    });
  });

  it("reads today's part of a range from the start of today to its end", () => {
    expect(reportWindowFromToday({ startDate: local(2026, 10, 1), endDate: local(2026, 10, 28) }, at)).toEqual({
      startDate: local(2026, 10, 27),
      endDate: local(2026, 10, 28),
    });
    expect(reportWindowFromToday({ startDate: local(2026, 10, 20), endDate: local(2026, 11, 3) }, at)).toEqual({
      startDate: local(2026, 10, 27),
      endDate: local(2026, 11, 3),
    });
  });
});

describe("dashboardRangePlan", () => {
  it("reads Today live, and this week on its first day", () => {
    expect(dashboardRangePlan({ kind: "preset", preset: "today" }, "2026-10-27")).toEqual({ kind: "live" });
    expect(dashboardRangePlan({ kind: "custom", startBusinessDate: "2026-10-27", endBusinessDateInclusive: "2026-10-27" }, "2026-10-27")).toEqual({ kind: "live" });
    expect(dashboardRangePlan({ kind: "preset", preset: "this_week" }, "2026-10-26")).toEqual({ kind: "live" });
  });

  it("splits the presets, and dates that match one, before today", () => {
    expect(dashboardRangePlan({ kind: "preset", preset: "this_week" }, "2026-10-27")).toEqual({
      kind: "split",
      history: { kind: "preset", preset: "this_week", throughYesterday: true },
      historyStartDate: "2026-10-26",
      historyEndDate: "2026-10-26",
    });
    // Dates that match a preset share the preset's cached answer.
    expect(dashboardRangePlan({ kind: "custom", startBusinessDate: "2026-10-01", endBusinessDateInclusive: "2026-10-27" }, "2026-10-27")).toMatchObject({
      kind: "split",
      history: { kind: "preset", preset: "this_month", throughYesterday: true },
    });
  });

  it("reads a range that ended before today from ClickHouse", () => {
    expect(dashboardRangePlan({ kind: "custom", startBusinessDate: "2026-10-01", endBusinessDateInclusive: "2026-10-26" }, "2026-10-27")).toEqual({
      kind: "warehouse",
      range: { kind: "custom", startDate: "2026-10-01", endDateInclusive: "2026-10-26" },
    });
    expect(dashboardRangePlan({ kind: "custom", startBusinessDate: "2026-09-01", endBusinessDateInclusive: "2026-09-30" }, "2026-10-27")).toEqual({
      kind: "warehouse",
      range: { kind: "preset", preset: "last_month" },
    });
  });

  it("reads today's part as the Today preset when the range ends today", () => {
    expect(dashboardRangeFromToday({ kind: "preset", preset: "this_month" }, "2026-10-27")).toEqual({ kind: "preset", preset: "today" });
    expect(dashboardRangeFromToday({ kind: "custom", startBusinessDate: "2026-10-01", endBusinessDateInclusive: "2026-11-02" }, "2026-10-27")).toEqual({
      kind: "custom",
      startBusinessDate: "2026-10-27",
      endBusinessDateInclusive: "2026-11-02",
    });
  });
});
