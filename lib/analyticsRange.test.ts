import { describe, expect, it } from "vitest";
import {
  analyticsRangeIsEmpty,
  dashboardRangeFromToday,
  dashboardRangePlan,
  EmptyAnalyticsRangeError,
  planAnalyticsRange,
  resolveAnalyticsRange,
  resolveDashboardRange,
} from "./analyticsRange";
import { addBusinessDays, businessDateForInstant, type BusinessDaySetting } from "./businessDay";
import {
  dashboardRangeToDayKeys,
  OPERATIONS_DASHBOARD_RANGE_VALIDATION,
  validateCustomDashboardRange,
} from "@/app/workspace/_components/dashboard-date-utils";
import { deriveOverviewRange } from "@/convex/dashboard/overviewRange";

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

describe("planAnalyticsRange", () => {
  const today = "2026-10-27";

  it("reads Today, and ranges from today on, live", () => {
    expect(planAnalyticsRange("2026-10-27", "2026-10-27", today)).toEqual({ kind: "live" });
    expect(planAnalyticsRange("2026-10-27", "2026-11-02", today)).toEqual({ kind: "live" });
  });

  it("reads a range that ended before today from ClickHouse, presets kept", () => {
    expect(planAnalyticsRange("2026-09-01", "2026-09-30", today)).toEqual({
      kind: "warehouse",
      range: { kind: "preset", preset: "last_month" },
    });
    expect(planAnalyticsRange("2026-10-03", "2026-10-10", today)).toEqual({
      kind: "warehouse",
      range: { kind: "custom", startDate: "2026-10-03", endDateInclusive: "2026-10-10" },
    });
  });

  it("splits a range that includes today at the start of today", () => {
    expect(planAnalyticsRange("2026-10-01", "2026-10-27", today)).toEqual({
      kind: "split",
      range: { kind: "preset", preset: "this_month" },
      history: { kind: "preset", preset: "this_month", throughYesterday: true },
      historyStartDate: "2026-10-01",
      historyEndDate: "2026-10-26",
    });
    expect(planAnalyticsRange("2026-10-26", "2026-10-27", today)).toMatchObject({
      kind: "split",
      history: { kind: "preset", preset: "this_week", throughYesterday: true },
    });
    // Dates that match no preset, here ending after today.
    expect(planAnalyticsRange("2026-10-20", "2026-11-02", today)).toEqual({
      kind: "split",
      range: { kind: "custom", startDate: "2026-10-20", endDateInclusive: "2026-11-02" },
      history: { kind: "custom", startDate: "2026-10-20", endDateInclusive: "2026-10-26" },
      historyStartDate: "2026-10-20",
      historyEndDate: "2026-10-26",
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
      range: { kind: "preset", preset: "this_week" },
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

  it("plans browser dates in business days when the business day hasn't started", () => {
    // 00:30 on the 28th in the browser is still the 27th's business day when
    // days start at 01:00. This month's browser dates run to the 28th.
    expect(dashboardRangePlan({ kind: "custom", startBusinessDate: "2026-10-01", endBusinessDateInclusive: "2026-10-28" }, "2026-10-27")).toEqual({
      kind: "split",
      range: { kind: "custom", startDate: "2026-10-01", endDateInclusive: "2026-10-28" },
      history: { kind: "custom", startDate: "2026-10-01", endDateInclusive: "2026-10-26" },
      historyStartDate: "2026-10-01",
      historyEndDate: "2026-10-26",
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

  it("names today's dates, so the live read moves to the next day at midnight", () => {
    expect(dashboardRangeFromToday({ kind: "preset", preset: "this_month" }, "2026-10-27")).toEqual({
      kind: "custom",
      startBusinessDate: "2026-10-27",
      endBusinessDateInclusive: "2026-10-27",
    });
    expect(dashboardRangeFromToday({ kind: "custom", startBusinessDate: "2026-10-01", endBusinessDateInclusive: "2026-11-02" }, "2026-10-27")).toEqual({
      kind: "custom",
      startBusinessDate: "2026-10-27",
      endBusinessDateInclusive: "2026-11-02",
    });
  });
});

describe("resolveDashboardRange", () => {
  const PRESETS = ["today", "this_week", "this_month"] as const;
  /** The dates a page sends at `ms`, for the tenant's business day. */
  const datesAt = (preset: (typeof PRESETS)[number], ms: number, day: BusinessDaySetting = tegucigalpa) =>
    resolveDashboardRange({ kind: "preset", preset }, businessDateForInstant(ms, day));
  const span = (startBusinessDate: string, endBusinessDateInclusive: string) => ({
    kind: "custom",
    startBusinessDate,
    endBusinessDateInclusive,
  });

  it("names Today, This week (from Monday) and This month (from the 1st), each through today", () => {
    // Thursday 2026-11-05.
    expect(resolveDashboardRange({ kind: "preset", preset: "today" }, "2026-11-05")).toEqual(span("2026-11-05", "2026-11-05"));
    expect(resolveDashboardRange({ kind: "preset", preset: "this_week" }, "2026-11-05")).toEqual(span("2026-11-02", "2026-11-05"));
    expect(resolveDashboardRange({ kind: "preset", preset: "this_month" }, "2026-11-05")).toEqual(span("2026-11-01", "2026-11-05"));
  });

  it("passes a custom range through unchanged", () => {
    const custom = span("2026-09-03", "2026-10-17") as Extract<Parameters<typeof resolveDashboardRange>[0], { kind: "custom" }>;
    expect(resolveDashboardRange(custom, "2026-11-05")).toBe(custom);
  });

  it("moves to the next day at the tenant's day start, not at midnight", () => {
    // Days start at 01:00 in Tegucigalpa (UTC-6): 00:59 on the 6th is still the 5th.
    expect(datesAt("today", Date.UTC(2026, 10, 6, 6, 59))).toEqual(span("2026-11-05", "2026-11-05"));
    expect(datesAt("today", Date.UTC(2026, 10, 6, 7, 0))).toEqual(span("2026-11-06", "2026-11-06"));
    const fourAm = { timeZone: "America/Tegucigalpa", dayStartHour: 4 };
    expect(datesAt("today", Date.UTC(2026, 10, 6, 9, 59), fourAm)).toEqual(span("2026-11-05", "2026-11-05"));
    expect(datesAt("today", Date.UTC(2026, 10, 6, 10, 0), fourAm)).toEqual(span("2026-11-06", "2026-11-06"));
  });

  it("starts a new week on Monday's business day, across month and year ends", () => {
    // Sunday 2026-11-01 runs from Monday 2026-10-26.
    expect(resolveDashboardRange({ kind: "preset", preset: "this_week" }, "2026-11-01")).toEqual(span("2026-10-26", "2026-11-01"));
    // Monday is a week of one day.
    expect(resolveDashboardRange({ kind: "preset", preset: "this_week" }, "2026-11-02")).toEqual(span("2026-11-02", "2026-11-02"));
    // Friday 2027-01-01 belongs to the week that began Monday 2026-12-28.
    expect(resolveDashboardRange({ kind: "preset", preset: "this_week" }, "2027-01-01")).toEqual(span("2026-12-28", "2027-01-01"));
    // 00:30 on Monday Nov 9 is still Sunday's business day: last week's range.
    expect(datesAt("this_week", Date.UTC(2026, 10, 9, 6, 30))).toEqual(span("2026-11-02", "2026-11-08"));
    expect(datesAt("this_week", Date.UTC(2026, 10, 9, 7, 30))).toEqual(span("2026-11-09", "2026-11-09"));
  });

  it("starts a new month on the 1st's business day, including leap years and the year end", () => {
    expect(resolveDashboardRange({ kind: "preset", preset: "this_month" }, "2026-12-01")).toEqual(span("2026-12-01", "2026-12-01"));
    expect(resolveDashboardRange({ kind: "preset", preset: "this_month" }, "2028-02-29")).toEqual(span("2028-02-01", "2028-02-29"));
    // 00:30 on Jan 1 is still Dec 31's business day: all of December.
    expect(datesAt("this_month", Date.UTC(2027, 0, 1, 6, 30))).toEqual(span("2026-12-01", "2026-12-31"));
    expect(datesAt("this_month", Date.UTC(2027, 0, 1, 7, 30))).toEqual(span("2027-01-01", "2027-01-01"));
  });

  it("reads today in the tenant's time zone, not the browser's or UTC", () => {
    // 22:00 UTC on Nov 5 is 16:00 Nov 5 in Tegucigalpa and 07:00 Nov 6 in Tokyo.
    const at = Date.UTC(2026, 10, 5, 22, 0);
    expect(datesAt("today", at)).toEqual(span("2026-11-05", "2026-11-05"));
    expect(datesAt("today", at, { timeZone: "Asia/Tokyo", dayStartHour: 1 })).toEqual(span("2026-11-06", "2026-11-06"));
    // Kiritimati (UTC+14) is already on the 6th at 10:00 UTC on the 5th.
    expect(datesAt("today", Date.UTC(2026, 10, 5, 10, 0), { timeZone: "Pacific/Kiritimati", dayStartHour: 0 })).toEqual(span("2026-11-06", "2026-11-06"));
  });

  it("keeps the day start across a daylight saving change", () => {
    const newYork = { timeZone: "America/New_York", dayStartHour: 1 };
    // Clocks fall back at 02:00 EDT on Sunday 2026-11-01; 01:00 happens twice and the first one starts the day.
    expect(datesAt("this_month", Date.UTC(2026, 10, 1, 4, 59), newYork)).toEqual(span("2026-10-01", "2026-10-31"));
    expect(datesAt("this_month", Date.UTC(2026, 10, 1, 5, 0), newYork)).toEqual(span("2026-11-01", "2026-11-01"));
    // Clocks spring forward at 02:00 EST on 2027-03-14; 01:00 EST still starts that day.
    expect(datesAt("today", Date.UTC(2027, 2, 14, 5, 59), newYork)).toEqual(span("2027-03-13", "2027-03-13"));
    expect(datesAt("today", Date.UTC(2027, 2, 14, 6, 0), newYork)).toEqual(span("2027-03-14", "2027-03-14"));
  });

  it("gives the server and the other client helpers the same dates for every day of a year", () => {
    // Noon UTC each day of 2026 and 2027, in two business-day definitions.
    for (const day of [tegucigalpa, { timeZone: "Asia/Tokyo", dayStartHour: 6 }]) {
      for (let date = "2026-01-01"; date <= "2027-12-31"; date = addBusinessDays(date, 1)) {
        const at = Date.parse(`${date}T12:00:00Z`);
        const today = businessDateForInstant(at, day);
        for (const preset of PRESETS) {
          const resolved = resolveDashboardRange({ kind: "preset", preset }, today);
          // The server answers the explicit dates exactly as it answered the preset on that day.
          const server = deriveOverviewRange({ kind: "preset", preset }, at, day);
          const explicit = deriveOverviewRange(resolved, at, day);
          expect([explicit.startBusinessDate, explicit.endBusinessDateInclusive]).toEqual([
            server.startBusinessDate,
            server.endBusinessDateInclusive,
          ]);
          expect(explicit.slackWindowStart).toBe(server.slackWindowStart);
          expect(explicit.slackWindowEnd).toBe(server.slackWindowEnd);
          // The day keys the lead gen and No-shows readers take agree too.
          expect(dashboardRangeToDayKeys({ kind: "preset", preset }, at, day)).toEqual({
            startDayKey: resolved.startBusinessDate,
            endDayKey: resolved.endBusinessDateInclusive,
          });
          // And "This month" as dates passes the custom range checks.
          expect(validateCustomDashboardRange(resolved)).toBeNull();
          expect(validateCustomDashboardRange(resolved, OPERATIONS_DASHBOARD_RANGE_VALIDATION)).toBeNull();
        }
      }
    }
  });
});
