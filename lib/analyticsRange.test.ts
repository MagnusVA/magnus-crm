import { describe, expect, it } from "vitest";
import {
  dashboardRangeToAnalyticsRange,
  reportRangeToAnalyticsRange,
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

describe("reportRangeToAnalyticsRange", () => {
  const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
  const at = new Date(2026, 9, 27, 15).getTime();

  it("keeps Today on the live reader", () => {
    expect(reportRangeToAnalyticsRange({ startDate: local(2026, 10, 27), endDate: local(2026, 10, 28) }, at)).toBeNull();
  });

  it("recognises the quick picks as presets", () => {
    expect(reportRangeToAnalyticsRange({ startDate: local(2026, 10, 1), endDate: local(2026, 10, 28) }, at)).toEqual({ kind: "preset", preset: "this_month" });
    expect(reportRangeToAnalyticsRange({ startDate: local(2026, 9, 1), endDate: local(2026, 10, 1) }, at)).toEqual({ kind: "preset", preset: "last_month" });
    expect(reportRangeToAnalyticsRange({ startDate: local(2026, 10, 26), endDate: local(2026, 10, 28) }, at)).toEqual({ kind: "preset", preset: "this_week" });
  });

  it("turns any other range into inclusive local dates", () => {
    expect(reportRangeToAnalyticsRange({ startDate: local(2026, 10, 3), endDate: local(2026, 10, 11) }, at)).toEqual({
      kind: "custom",
      startDate: "2026-10-03",
      endDateInclusive: "2026-10-10",
    });
  });
});

describe("dashboardRangeToAnalyticsRange", () => {
  it("keeps Today live and passes the other ranges through", () => {
    expect(dashboardRangeToAnalyticsRange({ kind: "preset", preset: "today" }, "2026-10-27")).toBeNull();
    expect(dashboardRangeToAnalyticsRange({ kind: "custom", startBusinessDate: "2026-10-27", endBusinessDateInclusive: "2026-10-27" }, "2026-10-27")).toBeNull();
    expect(dashboardRangeToAnalyticsRange({ kind: "preset", preset: "this_week" }, "2026-10-27")).toEqual({ kind: "preset", preset: "this_week" });
    expect(dashboardRangeToAnalyticsRange({ kind: "custom", startBusinessDate: "2026-10-01", endBusinessDateInclusive: "2026-10-26" }, "2026-10-27")).toEqual({
      kind: "custom",
      startDate: "2026-10-01",
      endDateInclusive: "2026-10-26",
    });
    // Dates that match a preset share the preset's cached answer.
    expect(dashboardRangeToAnalyticsRange({ kind: "custom", startBusinessDate: "2026-10-01", endBusinessDateInclusive: "2026-10-27" }, "2026-10-27")).toEqual({ kind: "preset", preset: "this_month" });
    expect(dashboardRangeToAnalyticsRange({ kind: "custom", startBusinessDate: "2026-09-01", endBusinessDateInclusive: "2026-09-30" }, "2026-10-27")).toEqual({ kind: "preset", preset: "last_month" });
  });
});
