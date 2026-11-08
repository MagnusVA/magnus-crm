import { addBusinessDays, businessDayStart, type BusinessDaySetting } from "./businessDay";

/** A Reports range in the tenant's business dates, as the shared picker resolves it. */
export type ReportBusinessDates = { startBusinessDate: string; endBusinessDateInclusive: string };

/** The day keys the meeting-bucket readers take: the first day and the day after the last. */
export function reportDayKeys(dates: ReportBusinessDates) {
  return {
    startDayKey: dates.startBusinessDate,
    endDayKeyExclusive: addBusinessDays(dates.endBusinessDateInclusive, 1),
  };
}

/**
 * The `[startDate, endDate)` window in ms the report readers take: from the
 * start of the first business day to the start of the day after the last, in
 * the tenant's day definition.
 */
export function reportWindow(dates: ReportBusinessDates, setting: BusinessDaySetting) {
  const keys = reportDayKeys(dates);
  return {
    startDate: businessDayStart(keys.startDayKey, setting),
    endDate: businessDayStart(keys.endDayKeyExclusive, setting),
  };
}
