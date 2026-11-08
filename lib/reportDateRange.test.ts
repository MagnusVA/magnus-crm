import { describe, expect, it } from "vitest";
import { businessDateForInstant, type BusinessDaySetting } from "./businessDay";
import { reportDayKeys, reportWindow } from "./reportDateRange";

const TEGUCIGALPA: BusinessDaySetting = { timeZone: "America/Tegucigalpa", dayStartHour: 1 };
const NEW_YORK: BusinessDaySetting = { timeZone: "America/New_York", dayStartHour: 0 };

describe("reportDayKeys", () => {
  it("ends the day after the last business date", () => {
    expect(reportDayKeys({ startBusinessDate: "2026-10-22", endBusinessDateInclusive: "2026-10-22" })).toEqual({
      startDayKey: "2026-10-22",
      endDayKeyExclusive: "2026-10-23",
    });
  });

  it("crosses a month and a year end", () => {
    expect(reportDayKeys({ startBusinessDate: "2026-12-01", endBusinessDateInclusive: "2026-12-31" })).toEqual({
      startDayKey: "2026-12-01",
      endDayKeyExclusive: "2027-01-01",
    });
  });
});

describe("reportWindow", () => {
  it("starts and ends at the tenant's day start, not the browser's midnight", () => {
    // Tegucigalpa is UTC-6 all year; days run 1:00 am to 1:00 am.
    expect(reportWindow({ startBusinessDate: "2026-11-05", endBusinessDateInclusive: "2026-11-05" }, TEGUCIGALPA)).toEqual({
      startDate: Date.UTC(2026, 10, 5, 7),
      endDate: Date.UTC(2026, 10, 6, 7),
    });
  });

  it("covers every instant of its business dates and nothing else", () => {
    const window = reportWindow({ startBusinessDate: "2026-11-02", endBusinessDateInclusive: "2026-11-05" }, TEGUCIGALPA);
    expect(businessDateForInstant(window.startDate, TEGUCIGALPA)).toBe("2026-11-02");
    expect(businessDateForInstant(window.startDate - 1, TEGUCIGALPA)).toBe("2026-11-01");
    expect(businessDateForInstant(window.endDate - 1, TEGUCIGALPA)).toBe("2026-11-05");
    expect(businessDateForInstant(window.endDate, TEGUCIGALPA)).toBe("2026-11-06");
  });

  it("keeps a day across a daylight saving change 23 or 25 hours long", () => {
    const spring = reportWindow({ startBusinessDate: "2026-03-08", endBusinessDateInclusive: "2026-03-08" }, NEW_YORK);
    const fall = reportWindow({ startBusinessDate: "2026-11-01", endBusinessDateInclusive: "2026-11-01" }, NEW_YORK);
    expect(spring.endDate - spring.startDate).toBe(23 * 3_600_000);
    expect(fall.endDate - fall.startDate).toBe(25 * 3_600_000);
  });
});
