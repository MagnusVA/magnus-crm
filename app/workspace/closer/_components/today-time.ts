import {
  addBusinessDays,
  businessDateForInstant,
  businessDayRange,
  businessDayStart,
  businessPeriodRange,
  type BusinessDaySetting,
} from "@/lib/businessDay";

// The Today page counts and prints time by the tenant's business day: days,
// weeks (from Monday) and months start at the day's start hour in the
// tenant's time zone, and clock times are that zone's. The header says so
// with `DayDefinition`.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions) {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", { timeZone, ...options });
    formatters.set(key, cached);
  }
  return cached;
}

/** "10:30" and "AM", apart, for the board's condensed times. */
export function clockParts(ms: number, timeZone: string) {
  const parts = formatter(timeZone, { hour: "numeric", minute: "2-digit" }).formatToParts(ms);
  const time = parts
    .filter((part) => part.type === "hour" || part.type === "minute" || part.type === "literal")
    .map((part) => part.value)
    .join("")
    .trim();
  const dayPeriod = parts.find((part) => part.type === "dayPeriod")?.value ?? "";
  return { time, dayPeriod };
}

/** "10:30 AM" */
export function formatClock(ms: number, timeZone: string) {
  return formatter(timeZone, { hour: "numeric", minute: "2-digit" }).format(ms);
}

/** "Oct 28" */
export function formatShortDate(ms: number, timeZone: string) {
  return formatter(timeZone, { month: "short", day: "numeric" }).format(ms);
}

/** "Oct 28, 4:30 PM" */
export function formatDateTime(ms: number, timeZone: string) {
  return formatter(timeZone, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
}


export type BoardTab = "today" | "tomorrow" | "week";

/** The board's range for a tab, from today's business date. */
export function boardRange(tab: BoardTab, today: string, setting: BusinessDaySetting) {
  if (tab === "today") return businessDayRange(today, setting);
  if (tab === "tomorrow") return businessDayRange(addBusinessDays(today, 1), setting);
  return businessPeriodRange(today, "week", setting);
}

export type PerformancePeriod =
  | { kind: "preset"; preset: "day" | "week" | "month" }
  | { kind: "custom"; startDate: string; endDateInclusive: string };

export type PerformanceRange = {
  startDate: number;
  endDate: number;
  /**
   * The period before, cut to the same elapsed length so the change compares
   * like with like ("this time last week"), or the whole previous span for a
   * custom range.
   */
  previous: { startDate: number; endDate: number };
  /** "this week", for "of 31 deals this week". */
  periodNoun: string;
  /** "vs this time last week" */
  comparisonLabel: string;
};

const PRESET_WORDS = {
  day: { noun: "today", comparison: "vs this time yesterday" },
  week: { noun: "this week", comparison: "vs this time last week" },
  month: { noun: "this month", comparison: "vs this time last month" },
} as const;

/**
 * The period's range from today's business date. `cutoff` is how far into
 * the current period to compare (the current hour, so the query's arguments
 * stay put between ticks).
 */
export function performanceRange(
  period: PerformancePeriod,
  today: string,
  cutoff: number,
  setting: BusinessDaySetting,
): PerformanceRange {
  if (period.kind === "custom") {
    const startDate = businessDayStart(period.startDate, setting);
    const endDate = businessDayStart(addBusinessDays(period.endDateInclusive, 1), setting);
    const days = Math.round((endDate - startDate) / 86_400_000);
    const previousStart = businessDayStart(addBusinessDays(period.startDate, -days), setting);
    return {
      startDate,
      endDate,
      previous: { startDate: previousStart, endDate: startDate },
      periodNoun: "in this range",
      comparisonLabel: `vs the ${days} ${days === 1 ? "day" : "days"} before`,
    };
  }

  const current = businessPeriodRange(today, period.preset, setting);
  const previousDay =
    period.preset === "day"
      ? addBusinessDays(today, -1)
      : period.preset === "week"
        ? addBusinessDays(today, -7)
        : previousMonthDay(today);
  const previousPeriod = businessPeriodRange(previousDay, period.preset, setting);
  const elapsed = Math.max(1, Math.min(cutoff, current.end) - current.start);
  return {
    startDate: current.start,
    endDate: current.end,
    previous: {
      startDate: previousPeriod.start,
      endDate: Math.min(previousPeriod.start + elapsed, previousPeriod.end),
    },
    periodNoun: PRESET_WORDS[period.preset].noun,
    comparisonLabel: PRESET_WORDS[period.preset].comparison,
  };
}

/** A day in the month before `dateKey`'s (the 1st, so it always exists). */
function previousMonthDay(dateKey: string) {
  const [year, month] = dateKey.split("-").map(Number);
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  return `${previousYear}-${String(previousMonth).padStart(2, "0")}-01`;
}

/** A business date ("2026-10-29") in words, such as "Thursday, Oct 29". */
export function formatBusinessDate(
  dateKey: string,
  options: Intl.DateTimeFormatOptions = { weekday: "long", month: "short", day: "numeric" },
) {
  return formatter("UTC", options).format(Date.parse(`${dateKey}T12:00:00Z`));
}

/** "Oct 26 – Nov 1": the business dates a range covers, its end exclusive. */
export function formatRangeLabel(startDate: number, endDate: number, setting: BusinessDaySetting) {
  const options = { month: "short", day: "numeric" } as const;
  const first = formatBusinessDate(businessDateForInstant(startDate, setting), options);
  const last = formatBusinessDate(businessDateForInstant(endDate - 1, setting), options);
  return first === last ? first : `${first} – ${last}`;
}
