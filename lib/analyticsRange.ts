import {
  addBusinessDays,
  businessDateForInstant,
  businessDayStart,
  businessPeriodDate,
  calendarDate,
  countBusinessDays,
  validateBusinessDay,
  type BusinessDaySetting,
} from "./businessDay";

/**
 * Ranges the reporting database answers (docs/plans/clickhouse-reporting.md §4).
 * Today never comes here: it is read live from Convex. A preset is resolved
 * when its answer is computed, so one cached answer for "this_month" serves the
 * whole month and the post-sync batch moves its end forward.
 */
export const ANALYTICS_PRESETS = [
  "yesterday",
  "this_week",
  "this_month",
  "last_month",
  "last_90_days",
] as const;

export type AnalyticsPreset = (typeof ANALYTICS_PRESETS)[number];

export type AnalyticsRange =
  | { kind: "preset"; preset: AnalyticsPreset }
  | { kind: "custom"; startDate: string; endDateInclusive: string };

export type ResolvedAnalyticsRange = {
  /** First day, `YYYY-MM-DD`, in the range's day definition. */
  startDate: string;
  /** Last day, `YYYY-MM-DD`, inclusive. */
  endDateInclusive: string;
  /** UTC instant the first day starts. */
  fromMs: number;
  /** UTC instant the day after the last one starts (exclusive). */
  toMs: number;
  timeZone: string;
  dayStartHour: number;
};

export const MAX_ANALYTICS_RANGE_DAYS = 731;

export function analyticsRangeDates(
  range: AnalyticsRange,
  today: string,
): { startDate: string; endDateInclusive: string } {
  if (range.kind === "custom") {
    return {
      startDate: range.startDate,
      endDateInclusive: range.endDateInclusive,
    };
  }
  switch (range.preset) {
    case "yesterday": {
      const yesterday = addBusinessDays(today, -1);
      return { startDate: yesterday, endDateInclusive: yesterday };
    }
    case "this_week":
      return {
        startDate: businessPeriodDate(today, "week"),
        endDateInclusive: today,
      };
    case "this_month":
      return {
        startDate: businessPeriodDate(today, "month"),
        endDateInclusive: today,
      };
    case "last_month": {
      const lastDay = addBusinessDays(businessPeriodDate(today, "month"), -1);
      return {
        startDate: businessPeriodDate(lastDay, "month"),
        endDateInclusive: lastDay,
      };
    }
    case "last_90_days":
      return {
        startDate: addBusinessDays(today, -89),
        endDateInclusive: today,
      };
  }
}

/**
 * Throws a plain `Error` with a message safe to show when the range or the day
 * definition is invalid.
 */
export function resolveAnalyticsRange(
  range: AnalyticsRange,
  day: BusinessDaySetting,
  nowMs: number,
): ResolvedAnalyticsRange {
  validateBusinessDay(day);
  const today = businessDateForInstant(nowMs, day);
  const { startDate, endDateInclusive } = analyticsRangeDates(range, today);
  calendarDate(startDate);
  calendarDate(endDateInclusive);
  if (startDate > endDateInclusive) {
    throw new Error("Choose an end date on or after the start date.");
  }
  const dayAfter = addBusinessDays(endDateInclusive, 1);
  if (countBusinessDays(startDate, dayAfter) > MAX_ANALYTICS_RANGE_DAYS) {
    throw new Error(`Choose ${MAX_ANALYTICS_RANGE_DAYS} days or fewer.`);
  }
  return {
    startDate,
    endDateInclusive,
    fromMs: businessDayStart(startDate, day),
    toMs: businessDayStart(dayAfter, day),
    timeZone: day.timeZone,
    dayStartHour: day.dayStartHour,
  };
}

/** The day a range resolves against, as the browser sees it. */
export function browserDay(timeZone: string): BusinessDaySetting {
  return { timeZone, dayStartHour: 0 };
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** `YYYY-MM-DD` of an instant in the browser's own time zone. */
export function localDateKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Maps a Reports page range (browser-local `[startDate, endDate)` in ms) to
 * what ClickHouse answers. Returns null for Today, which the page reads live.
 * A range that matches a preset becomes the preset, so its cached answer
 * stays valid as days pass.
 */
export function reportRangeToAnalyticsRange(
  range: { startDate: number; endDate: number },
  nowMs: number,
): AnalyticsRange | null {
  return datesToAnalyticsRange(localDateKey(range.startDate), localDateKey(range.endDate - 1), localDateKey(nowMs));
}

/**
 * Today is null (read live). Dates that match a preset become the preset, so
 * the cached answer rolls forward with the calendar; anything else is custom.
 */
export function datesToAnalyticsRange(
  startDate: string,
  endDateInclusive: string,
  today: string,
): AnalyticsRange | null {
  if (startDate === today && endDateInclusive === today) return null;
  for (const preset of ANALYTICS_PRESETS) {
    const dates = analyticsRangeDates({ kind: "preset", preset }, today);
    if (dates.startDate === startDate && dates.endDateInclusive === endDateInclusive) {
      return { kind: "preset", preset };
    }
  }
  return { kind: "custom", startDate, endDateInclusive };
}

/**
 * Maps an Overview, Operations or lead gen range (business dates) to what
 * ClickHouse answers. Returns null for Today, which the page reads live.
 */
export function dashboardRangeToAnalyticsRange(
  range:
    | { kind: "preset"; preset: "today" | "this_week" | "this_month" }
    | { kind: "custom"; startBusinessDate: string; endBusinessDateInclusive: string },
  todayBusinessDate: string,
): AnalyticsRange | null {
  if (range.kind === "preset") {
    return range.preset === "today" ? null : { kind: "preset", preset: range.preset };
  }
  return datesToAnalyticsRange(range.startBusinessDate, range.endBusinessDateInclusive, todayBusinessDate);
}
