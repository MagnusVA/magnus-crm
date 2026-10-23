import { describe, expect, it } from "vitest";
import { addBusinessDays, businessDateForInstant, businessDayRange, businessDayStart, businessPeriodDate, businessPeriodKey, businessPeriodRange, countBusinessDays, validateBusinessDay } from "./businessDay";

describe("business days", () => {
  it("defaults to 07:00 UTC, including an evening on its own Honduras date", () => {
    expect(businessDayStart("2026-09-30")).toBe(Date.parse("2026-09-30T07:00Z"));
    expect(businessDateForInstant(Date.parse("2026-10-01T02:00Z"))).toBe("2026-09-30");
    expect(businessDateForInstant(Date.parse("2026-10-01T06:59:59.999Z"))).toBe("2026-09-30");
    expect(businessDateForInstant(Date.parse("2026-10-01T07:00Z"))).toBe("2026-10-01");
  });
  it.each([
    ["2026-03-07", 24], ["2026-03-08", 23], ["2026-11-01", 25], ["2026-11-02", 24],
  ])("uses the zone's offset on %s (%s hours)", (date, hours) => {
    const setting = { timeZone: "America/New_York", dayStartHour: 1 };
    const { start, end } = businessDayRange(date, setting);
    expect((end - start) / 3_600_000).toBe(hours);
    expect(businessDateForInstant(start, setting)).toBe(date);
    expect(businessDateForInstant(end - 1, setting)).toBe(date);
    expect(businessDateForInstant(end, setting)).toBe(addBusinessDays(date, 1));
  });
  it("moves a missing start hour to the first instant after the gap", () => {
    const setting = { timeZone: "America/New_York", dayStartHour: 2 };
    const at = businessDayStart("2026-03-08", setting);
    expect(at).toBe(Date.parse("2026-03-08T07:00Z"));
    expect(businessDateForInstant(at - 1, setting)).toBe("2026-03-07");
    expect(businessDateForInstant(at, setting)).toBe("2026-03-08");
    expect(businessDayStart("2026-10-04", { timeZone: "Australia/Lord_Howe", dayStartHour: 2 })).toBe(Date.parse("2026-10-03T15:30Z"));
  });
  it("chooses the first occurrence of an overlapping start hour", () => {
    const setting = { timeZone: "America/New_York", dayStartHour: 1 };
    expect(businessDayStart("2026-11-01", setting)).toBe(Date.parse("2026-11-01T05:00Z"));
    expect(businessDateForInstant(Date.parse("2026-11-01T06:00Z"), setting)).toBe("2026-11-01");
  });
  it("keeps label arithmetic independent of DST and uses Monday ISO weeks", () => {
    expect(addBusinessDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(countBusinessDays("2026-03-01", "2026-04-01")).toBe(31);
    expect(businessPeriodDate("2026-10-25", "week")).toBe("2026-10-19");
    expect(businessPeriodKey("2021-01-01", "week")).toBe("2020-W53");
    expect(businessPeriodRange("2026-03-20", "month", { timeZone: "America/New_York", dayStartHour: 1 })).toEqual({ start: Date.parse("2026-03-01T06:00Z"), end: Date.parse("2026-04-01T05:00Z") });
  });
  it("supports fractional zone offsets and midnight", () => {
    expect(businessDayStart("2026-01-01", { timeZone: "Asia/Kathmandu", dayStartHour: 0 })).toBe(Date.parse("2025-12-31T18:15Z"));
  });
  it("rejects invalid inputs", () => {
    for (const dayStartHour of [-1, 24, 1.5, NaN]) expect(() => validateBusinessDay({ timeZone: "UTC", dayStartHour })).toThrow();
    expect(() => validateBusinessDay({ timeZone: "Invalid/Zone", dayStartHour: 1 })).toThrow();
    for (const key of ["2026-02-30", "2026-2-01", "bad"]) expect(() => businessDayStart(key)).toThrow();
    expect(() => businessDateForInstant(NaN)).toThrow();
  });
});
