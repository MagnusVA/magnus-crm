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
 * Ranges the reporting database answers (docs/agents/reporting.md). Today
 * never comes here: it is read live from Convex. A preset is resolved when its
 * answer is computed, so one cached answer for "this_month" serves the whole
 * month and the post-sync batch moves its end forward.
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
  | {
      kind: "preset";
      preset: AnalyticsPreset;
      /**
       * Ends the preset yesterday: the days before today, which a page that
       * reads today live asks ClickHouse for (`planAnalyticsRange`).
       */
      throughYesterday?: true;
    }
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

function presetDates(
  preset: AnalyticsPreset,
  today: string,
): { startDate: string; endDateInclusive: string } {
  switch (preset) {
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
 * A range's first and last day when `today` is the current day. A preset
 * ended yesterday has no days on its first day (this week, on Monday): its
 * start then falls after its end.
 */
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
  const dates = presetDates(range.preset, today);
  if (!range.throughYesterday) return dates;
  const yesterday = addBusinessDays(today, -1);
  return {
    startDate: dates.startDate,
    endDateInclusive: dates.endDateInclusive < yesterday ? dates.endDateInclusive : yesterday,
  };
}

/** Whether a range has no days yet: a preset ended yesterday, on its first day. */
export function analyticsRangeIsEmpty(range: AnalyticsRange, today: string): boolean {
  const { startDate, endDateInclusive } = analyticsRangeDates(range, today);
  return startDate > endDateInclusive;
}

/** A preset ended yesterday, resolved on its first day. Nothing to ask ClickHouse. */
export class EmptyAnalyticsRangeError extends Error {
  constructor() {
    super("This range has no days before today yet.");
    this.name = "EmptyAnalyticsRangeError";
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
    if (range.kind === "preset") throw new EmptyAnalyticsRangeError();
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

/**
 * How a page whose ranges ClickHouse answers reads one (docs/agents/reporting.md):
 *
 * - `live`: the range starts today or later, so Convex answers all of it.
 * - `warehouse`: the range ended before today, so ClickHouse answers all of it.
 * - `split`: ClickHouse answers the days before today (`history`, which
 *   covers `historyStartDate` to `historyEndDate`), Convex answers the rest
 *   live, and the page merges the two answers. `range` is the whole range,
 *   for a report that can't be split and reads it from ClickHouse as of the
 *   last sync.
 */
export type AnalyticsRangePlan =
  | { kind: "live" }
  | { kind: "warehouse"; range: AnalyticsRange }
  | {
      kind: "split";
      range: AnalyticsRange;
      history: AnalyticsRange;
      historyStartDate: string;
      historyEndDate: string;
    };

/**
 * The cached range for some dates. Dates that match a preset become the
 * preset, so its answer stays valid as days pass; anything else is custom.
 */
function rangeForDates(startDate: string, endDateInclusive: string, today: string): AnalyticsRange {
  for (const preset of ANALYTICS_PRESETS) {
    const dates = presetDates(preset, today);
    if (dates.startDate === startDate && dates.endDateInclusive === endDateInclusive) {
      return { kind: "preset", preset };
    }
  }
  return { kind: "custom", startDate, endDateInclusive };
}

/** Plans a range of inclusive dates, in the page's day definition. */
export function planAnalyticsRange(
  startDate: string,
  endDateInclusive: string,
  today: string,
): AnalyticsRangePlan {
  if (startDate >= today) return { kind: "live" };
  const whole = rangeForDates(startDate, endDateInclusive, today);
  if (endDateInclusive < today) return { kind: "warehouse", range: whole };
  const yesterday = addBusinessDays(today, -1);
  return {
    kind: "split",
    range: whole,
    history:
      whole.kind === "preset"
        ? { ...whole, throughYesterday: true }
        : { kind: "custom", startDate, endDateInclusive: yesterday },
    historyStartDate: startDate,
    historyEndDate: yesterday,
  };
}

/** An Overview, Operations or lead gen range, in business dates. */
export type DashboardRange =
  | { kind: "preset"; preset: "today" | "this_week" | "this_month" }
  | { kind: "custom"; startBusinessDate: string; endBusinessDateInclusive: string };

/**
 * Plans an Overview, Operations or lead gen range, in the tenant's business
 * days. A custom range of one day reads live even when it's before today:
 * one day is a small read for the page's Convex reader, and it skips waiting
 * on a ClickHouse run.
 */
export function dashboardRangePlan(range: DashboardRange, todayBusinessDate: string): AnalyticsRangePlan {
  if (range.kind === "custom") {
    if (range.startBusinessDate === range.endBusinessDateInclusive) return { kind: "live" };
    return planAnalyticsRange(range.startBusinessDate, range.endBusinessDateInclusive, todayBusinessDate);
  }
  if (range.preset === "today") return { kind: "live" };
  const dates = presetDates(range.preset, todayBusinessDate);
  return planAnalyticsRange(dates.startDate, dates.endDateInclusive, todayBusinessDate);
}

/**
 * The part of a dashboard range from today, for its live reader. It names the
 * dates rather than the Today preset: a query resolves a preset from the
 * clock, and Convex doesn't run it again when the day changes, so after
 * midnight the preset could still answer for yesterday.
 */
export function dashboardRangeFromToday(range: DashboardRange, todayBusinessDate: string): DashboardRange {
  const end = range.kind === "custom" ? range.endBusinessDateInclusive : todayBusinessDate;
  return {
    kind: "custom",
    startBusinessDate: todayBusinessDate,
    endBusinessDateInclusive: end > todayBusinessDate ? end : todayBusinessDate,
  };
}

/**
 * A dashboard range as the business dates it covers when today is
 * `todayBusinessDate`: Today, This week (from Monday) and This month (from
 * the 1st) each end today. Pages send this to their Convex readers instead of
 * the preset. A query that resolved the preset itself would read the server's
 * clock, and Convex doesn't run a query again because time passed, so a page
 * left open past the business day's change kept yesterday's numbers. Named
 * dates change when today does, and the query runs again for the new day.
 */
export function resolveDashboardRange(
  range: DashboardRange,
  todayBusinessDate: string,
): Extract<DashboardRange, { kind: "custom" }> {
  if (range.kind === "custom") return range;
  const { startDate, endDateInclusive } =
    range.preset === "today"
      ? { startDate: todayBusinessDate, endDateInclusive: todayBusinessDate }
      : presetDates(range.preset, todayBusinessDate);
  return { kind: "custom", startBusinessDate: startDate, endBusinessDateInclusive: endDateInclusive };
}
