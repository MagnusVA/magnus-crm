import { describe, expect, it } from "vitest";
import { endOfMonth, startOfMonth } from "date-fns";
import { reportRangeDayKeys } from "./reportDateRange";

describe("browser report ranges mapped to business-day labels", () => {
  it("keeps Today on its selected calendar date, even before the business-day start", () => {
    expect(reportRangeDayKeys({
      startDate: new Date(2026, 9, 22).getTime(),
      endDate: new Date(2026, 9, 23).getTime(),
    })).toEqual({ startDayKey: "2026-10-22", endDayKeyExclusive: "2026-10-23" });
  });

  it("does not include the previous month for This Month", () => {
    expect(reportRangeDayKeys({
      startDate: startOfMonth(new Date(2026, 9, 22)).getTime(),
      endDate: new Date(2026, 9, 23).getTime(),
    })).toEqual({ startDayKey: "2026-10-01", endDayKeyExclusive: "2026-10-23" });
  });

  it("supports both an inclusive endOfMonth default and an exclusive midnight", () => {
    for (const endDate of [endOfMonth(new Date(2026, 11, 15)).getTime(), new Date(2027, 0, 1).getTime()]) {
      expect(reportRangeDayKeys({ startDate: new Date(2026, 11, 1).getTime(), endDate }))
        .toEqual({ startDayKey: "2026-12-01", endDayKeyExclusive: "2027-01-01" });
    }
  });

  it.each([[2, 8], [10, 1]])("uses calendar arithmetic across the DST boundary %s/%s", (month, day) => {
    const startDate = new Date(2026, month, day).getTime();
    const endDate = new Date(2026, month, day + 1).getTime();
    const prefix = `2026-${String(month + 1).padStart(2, "0")}-`;
    expect(reportRangeDayKeys({ startDate, endDate })).toEqual({
      startDayKey: `${prefix}${String(day).padStart(2, "0")}`,
      endDayKeyExclusive: `${prefix}${String(day + 1).padStart(2, "0")}`,
    });
  });
});
