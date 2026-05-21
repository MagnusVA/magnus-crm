const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BUSINESS_DAY_UTC_START_HOUR = 7;
const MAX_PERIODS = 120;

export type SlackQualificationGranularity = "day" | "week" | "month";

export type SlackQualificationFilters = {
  startBusinessDate: string;
  endBusinessDateExclusive: string;
  granularity: SlackQualificationGranularity;
  slackUserId: string | null;
};

export function getInitialSlackQualificationFilters(): SlackQualificationFilters {
  const today = getCurrentHondurasBusinessDate();
  return {
    startBusinessDate: today,
    endBusinessDateExclusive: addBusinessDays(today, 1),
    granularity: "day",
    slackUserId: null,
  };
}

export function getCurrentHondurasBusinessDate(now = Date.now()): string {
  return timestampToBusinessDateKey(now);
}

export function timestampToBusinessDateKey(timestamp: number): string {
  const shifted = new Date(timestamp - BUSINESS_DAY_UTC_START_HOUR * HOUR_MS);
  return formatDateKey(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

export function addBusinessDays(dateKey: string, days: number): string {
  return timestampToBusinessDateKey(businessDateToUtcStart(dateKey) + days * DAY_MS);
}

export function businessDateToCalendarDate(dateKey: string): Date {
  const { year, month, day } = parseBusinessDateKey(dateKey);
  return new Date(year, month - 1, day);
}

export function calendarDateToBusinessDate(date: Date): string {
  return formatDateKey(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export function getInclusiveEndBusinessDate(endBusinessDateExclusive: string): string {
  return addBusinessDays(endBusinessDateExclusive, -1);
}

export function countBusinessDays(
  startBusinessDate: string,
  endBusinessDateExclusive: string,
): number {
  return Math.round(
    (businessDateToUtcStart(endBusinessDateExclusive) -
      businessDateToUtcStart(startBusinessDate)) /
      DAY_MS,
  );
}

export function getRangeValidationMessage(
  filters: SlackQualificationFilters,
): string | null {
  const days = countBusinessDays(
    filters.startBusinessDate,
    filters.endBusinessDateExclusive,
  );
  if (days <= 0) {
    return "Choose an end date after the start date.";
  }
  if (days > 730) {
    return "Choose a range of 730 business days or fewer.";
  }
  if (estimatePeriodCount(filters) > MAX_PERIODS) {
    return `This range creates more than ${MAX_PERIODS} ${filters.granularity} buckets. Narrow the range or use a larger granularity.`;
  }
  return null;
}

export function getQuickRange(
  key: "today" | "yesterday" | "this_week" | "this_month" | "last_30",
): Pick<SlackQualificationFilters, "startBusinessDate" | "endBusinessDateExclusive"> {
  const today = getCurrentHondurasBusinessDate();
  const tomorrow = addBusinessDays(today, 1);

  switch (key) {
    case "today":
      return {
        startBusinessDate: today,
        endBusinessDateExclusive: tomorrow,
      };
    case "yesterday":
      return {
        startBusinessDate: addBusinessDays(today, -1),
        endBusinessDateExclusive: today,
      };
    case "this_week":
      return {
        startBusinessDate: startOfBusinessIsoWeek(today),
        endBusinessDateExclusive: tomorrow,
      };
    case "this_month":
      return {
        startBusinessDate: startOfBusinessMonth(today),
        endBusinessDateExclusive: tomorrow,
      };
    case "last_30":
      return {
        startBusinessDate: addBusinessDays(today, -29),
        endBusinessDateExclusive: tomorrow,
      };
  }
}

function estimatePeriodCount(filters: SlackQualificationFilters): number {
  let cursor = filters.startBusinessDate;
  let periods = 0;

  while (cursor < filters.endBusinessDateExclusive && periods <= MAX_PERIODS) {
    const periodStart = getPeriodStartBusinessDate(cursor, filters.granularity);
    const nextBoundary = getNextPeriodStartBusinessDate(
      periodStart,
      filters.granularity,
    );
    cursor =
      nextBoundary < filters.endBusinessDateExclusive
        ? nextBoundary
        : filters.endBusinessDateExclusive;
    periods += 1;
  }

  return periods;
}

export function businessDateToUtcStart(dateKey: string): number {
  const { year, month, day } = parseBusinessDateKey(dateKey);
  return Date.UTC(year, month - 1, day, BUSINESS_DAY_UTC_START_HOUR);
}

function getPeriodStartBusinessDate(
  dateKey: string,
  granularity: SlackQualificationGranularity,
): string {
  switch (granularity) {
    case "day":
      return dateKey;
    case "week":
      return startOfBusinessIsoWeek(dateKey);
    case "month":
      return startOfBusinessMonth(dateKey);
  }
}

function getNextPeriodStartBusinessDate(
  periodStartKey: string,
  granularity: SlackQualificationGranularity,
): string {
  switch (granularity) {
    case "day":
      return addBusinessDays(periodStartKey, 1);
    case "week":
      return addBusinessDays(periodStartKey, 7);
    case "month": {
      const { year, month } = parseBusinessDateKey(periodStartKey);
      const next = new Date(Date.UTC(year, month, 1));
      return formatDateKey(
        next.getUTCFullYear(),
        next.getUTCMonth() + 1,
        next.getUTCDate(),
      );
    }
  }
}

function startOfBusinessMonth(dateKey: string): string {
  const { year, month } = parseBusinessDateKey(dateKey);
  return formatDateKey(year, month, 1);
}

function startOfBusinessIsoWeek(dateKey: string): string {
  const { year, month, day } = parseBusinessDateKey(dateKey);
  const date = new Date(Date.UTC(year, month - 1, day));
  const utcDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (utcDay - 1));
  return formatDateKey(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function parseBusinessDateKey(dateKey: string): {
  year: number;
  month: number;
  day: number;
} {
  const [yearRaw, monthRaw, dayRaw] = dateKey.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  return { year, month, day };
}

function formatDateKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
