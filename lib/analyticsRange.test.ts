import { describe, expect, it } from "vitest";
import {
  analyticsRangeIsEmpty,
  MAX_ANALYTICS_RANGE_DAYS,
  REPORT_RANGE_PRESETS,
  type ReportRangePreset,
  dashboardRangeFromToday,
  dashboardLiveRange,
  dashboardRangePlan,
  EmptyAnalyticsRangeError,
  planAnalyticsRange,
  settledThroughDate,
  resolveAnalyticsRange,
  resolveDashboardRange,
} from "./analyticsRange";
import { addBusinessDays, businessDateForInstant, countBusinessDays, type BusinessDaySetting } from "./businessDay";
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
      liveStartDate: "2026-10-27",
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
      liveStartDate: "2026-10-27",
    });
  });

  it("reads yesterday live too until a sync after the day's start has landed (D1)", () => {
    const settled = "2026-10-25"; // the evening sync missed late Oct 26
    // This month: ClickHouse through Oct 25, Convex for Oct 26 and today.
    expect(planAnalyticsRange("2026-10-01", "2026-10-27", today, settled)).toEqual({
      kind: "split",
      range: { kind: "preset", preset: "this_month" },
      history: { kind: "custom", startDate: "2026-10-01", endDateInclusive: "2026-10-25" },
      historyStartDate: "2026-10-01",
      historyEndDate: "2026-10-25",
      liveStartDate: "2026-10-26",
      liveFromYesterday: true,
    });
    // A range that ended yesterday is split too, its last day read live.
    expect(planAnalyticsRange("2026-10-20", "2026-10-26", today, settled)).toMatchObject({
      kind: "split",
      historyEndDate: "2026-10-25",
      liveStartDate: "2026-10-26",
    });
    // A range from yesterday on is all live.
    expect(planAnalyticsRange("2026-10-26", "2026-10-27", today, settled)).toEqual({ kind: "live" });
    // Ranges that ended before the settled day are unaffected.
    expect(planAnalyticsRange("2026-09-01", "2026-09-30", today, settled)).toEqual({
      kind: "warehouse",
      range: { kind: "preset", preset: "last_month" },
    });
  });
});

describe("settledThroughDate", () => {
  const today = "2026-10-27";
  const todayStart = Date.parse("2026-10-27T07:00:00Z");

  it("is yesterday once the watermark passes the start of today", () => {
    expect(settledThroughDate(today, todayStart + 1, todayStart)).toBe("2026-10-26");
    expect(settledThroughDate(today, todayStart, todayStart)).toBe("2026-10-26");
  });

  it("is the day before yesterday until then, or with no sync at all", () => {
    expect(settledThroughDate(today, todayStart - 1, todayStart)).toBe("2026-10-25");
    expect(settledThroughDate(today, null, todayStart)).toBe("2026-10-25");
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
      liveStartDate: "2026-10-27",
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
      liveStartDate: "2026-10-27",
    });
  });

  it("reads a single custom day live, even before today", () => {
    expect(dashboardRangePlan({ kind: "custom", startBusinessDate: "2026-10-26", endBusinessDateInclusive: "2026-10-26" }, "2026-10-27")).toEqual({ kind: "live" });
    expect(dashboardRangePlan({ kind: "custom", startBusinessDate: "2026-03-14", endBusinessDateInclusive: "2026-03-14" }, "2026-10-27")).toEqual({ kind: "live" });
    // Two days still read ClickHouse.
    expect(dashboardRangePlan({ kind: "custom", startBusinessDate: "2026-10-25", endBusinessDateInclusive: "2026-10-26" }, "2026-10-27")).toMatchObject({ kind: "warehouse" });
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

describe("Reports presets", () => {
  const preset = (name: ReportRangePreset) => ({ kind: "preset", preset: name }) as const;
  const span = (startBusinessDate: string, endBusinessDateInclusive: string) => ({
    kind: "custom",
    startBusinessDate,
    endBusinessDateInclusive,
  });
  // Thursday 2026-11-05.
  const today = "2026-11-05";

  it("names each preset's business dates", () => {
    expect(resolveDashboardRange(preset("yesterday"), today)).toEqual(span("2026-11-04", "2026-11-04"));
    expect(resolveDashboardRange(preset("last_week"), today)).toEqual(span("2026-10-26", "2026-11-01"));
    expect(resolveDashboardRange(preset("last_month"), today)).toEqual(span("2026-10-01", "2026-10-31"));
    expect(resolveDashboardRange(preset("last_90_days"), today)).toEqual(span("2026-08-08", "2026-11-05"));
    expect(resolveDashboardRange(preset("year_to_date"), today)).toEqual(span("2026-01-01", "2026-11-05"));
  });

  it("takes last week as the Monday to Sunday before this week, whatever today is", () => {
    // Monday: last week ended yesterday.
    expect(resolveDashboardRange(preset("last_week"), "2026-11-02")).toEqual(span("2026-10-26", "2026-11-01"));
    // Sunday is still in this week.
    expect(resolveDashboardRange(preset("last_week"), "2026-11-08")).toEqual(span("2026-10-26", "2026-11-01"));
    // Across a year end.
    expect(resolveDashboardRange(preset("last_week"), "2027-01-05")).toEqual(span("2026-12-28", "2027-01-03"));
  });

  it("starts year to date on January 1, which is one day on New Year's Day", () => {
    expect(resolveDashboardRange(preset("year_to_date"), "2027-01-01")).toEqual(span("2027-01-01", "2027-01-01"));
    expect(resolveDashboardRange(preset("year_to_date"), "2028-12-31")).toEqual(span("2028-01-01", "2028-12-31"));
  });

  it("stays within the longest range for every preset on every day of a leap year", () => {
    for (let date = "2028-01-01"; date <= "2028-12-31"; date = addBusinessDays(date, 1)) {
      for (const name of REPORT_RANGE_PRESETS) {
        const { startBusinessDate, endBusinessDateInclusive } = resolveDashboardRange(preset(name), date);
        expect(startBusinessDate <= endBusinessDateInclusive).toBe(true);
        expect(countBusinessDays(startBusinessDate, addBusinessDays(endBusinessDateInclusive, 1))).toBeLessThanOrEqual(
          MAX_ANALYTICS_RANGE_DAYS,
        );
      }
    }
  });

  it("plans yesterday, last month and last 90 days as the analytics presets, to share their answers", () => {
    expect(dashboardRangePlan(preset("yesterday"), today)).toEqual({
      kind: "warehouse",
      range: { kind: "preset", preset: "yesterday" },
    });
    expect(dashboardRangePlan(preset("last_month"), today)).toEqual({
      kind: "warehouse",
      range: { kind: "preset", preset: "last_month" },
    });
    expect(dashboardRangePlan(preset("last_90_days"), today)).toEqual({
      kind: "split",
      range: { kind: "preset", preset: "last_90_days" },
      history: { kind: "preset", preset: "last_90_days", throughYesterday: true },
      historyStartDate: "2026-08-08",
      historyEndDate: "2026-11-04",
      liveStartDate: "2026-11-05",
    });
  });

  it("plans last week and year to date as dates", () => {
    expect(dashboardRangePlan(preset("last_week"), today)).toEqual({
      kind: "warehouse",
      range: { kind: "custom", startDate: "2026-10-26", endDateInclusive: "2026-11-01" },
    });
    // On Monday, last week ended yesterday: still all ClickHouse.
    expect(dashboardRangePlan(preset("last_week"), "2026-11-02")).toEqual({
      kind: "warehouse",
      range: { kind: "custom", startDate: "2026-10-26", endDateInclusive: "2026-11-01" },
    });
    expect(dashboardRangePlan(preset("year_to_date"), today)).toEqual({
      kind: "split",
      range: { kind: "custom", startDate: "2026-01-01", endDateInclusive: "2026-11-05" },
      history: { kind: "custom", startDate: "2026-01-01", endDateInclusive: "2026-11-04" },
      historyStartDate: "2026-01-01",
      historyEndDate: "2026-11-04",
      liveStartDate: "2026-11-05",
    });
    // New Year's Day is today only: live.
    expect(dashboardRangePlan(preset("year_to_date"), "2027-01-01")).toEqual({ kind: "live" });
  });

  it("reads yesterday live overnight, until the morning sync lands", () => {
    const settled = addBusinessDays(today, -2);
    // Yesterday alone, and last week on Monday, have their last day read live.
    expect(dashboardRangePlan(preset("yesterday"), today, settled)).toEqual({ kind: "live" });
    expect(dashboardRangePlan(preset("last_week"), "2026-11-02", "2026-10-31")).toMatchObject({
      kind: "split",
      historyEndDate: "2026-10-31",
      liveStartDate: "2026-11-01",
      liveFromYesterday: true,
    });
    expect(dashboardRangePlan(preset("year_to_date"), today, settled)).toMatchObject({
      kind: "split",
      history: { kind: "custom", startDate: "2026-01-01", endDateInclusive: "2026-11-03" },
      liveStartDate: "2026-11-04",
      liveFromYesterday: true,
    });
    // The live part runs from yesterday to the range's end.
    expect(dashboardLiveRange(preset("year_to_date"), today, "2026-11-04")).toEqual(span("2026-11-04", "2026-11-05"));
    // Ranges that ended before the settled day are unaffected.
    expect(dashboardRangePlan(preset("last_month"), today, settled)).toEqual({
      kind: "warehouse",
      range: { kind: "preset", preset: "last_month" },
    });
  });
});
