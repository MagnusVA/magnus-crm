import { v } from "convex/values";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REPORT_PERIODS = 120;

export const HONDURAS_TIME_ZONE = "America/Tegucigalpa";
export const HONDURAS_UTC_OFFSET_HOURS = -6;
export const BUSINESS_DAY_START_HOUR = 1;

export const BUSINESS_DAY_UTC_START_HOUR =
  BUSINESS_DAY_START_HOUR - HONDURAS_UTC_OFFSET_HOURS;

export type ReportGranularity = "day" | "week" | "month";

export const reportGranularityValidator = v.union(
  v.literal("day"),
  v.literal("week"),
  v.literal("month"),
);

export type BusinessPeriod = {
  key: string;
  start: number;
  end: number;
  goalDays: number;
};

export function businessDateToUtcStart(dateKey: string): number {
  const { year, month, day } = parseBusinessDateKey(dateKey);
  return Date.UTC(year, month - 1, day, BUSINESS_DAY_UTC_START_HOUR);
}

export function timestampToBusinessDateKey(timestamp: number): string {
  if (!Number.isFinite(timestamp)) {
    throw new Error("Invalid timestamp.");
  }

  const shifted = new Date(timestamp - BUSINESS_DAY_UTC_START_HOUR * HOUR_MS);
  return formatUtcDateKey(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

export function addBusinessDays(dateKey: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new Error("Business-day offset must be an integer.");
  }

  return timestampToBusinessDateKey(
    businessDateToUtcStart(dateKey) + days * DAY_MS,
  );
}

export function countBusinessDays(
  startBusinessDate: string,
  endBusinessDateExclusive: string,
): number {
  const start = businessDateToUtcStart(startBusinessDate);
  const end = businessDateToUtcStart(endBusinessDateExclusive);
  if (end <= start) {
    throw new Error("End business date must be after start business date.");
  }

  return Math.round((end - start) / DAY_MS);
}

export function buildBusinessPeriods(args: {
  startBusinessDate: string;
  endBusinessDateExclusive: string;
  granularity: ReportGranularity;
}): BusinessPeriod[] {
  const rangeDays = countBusinessDays(
    args.startBusinessDate,
    args.endBusinessDateExclusive,
  );
  if (rangeDays > 730) {
    throw new Error("Date range cannot exceed 730 business days.");
  }

  const periods: BusinessPeriod[] = [];
  let cursor = args.startBusinessDate;

  while (cursor < args.endBusinessDateExclusive) {
    if (periods.length >= MAX_REPORT_PERIODS) {
      throw new Error(
        `Date range creates more than ${MAX_REPORT_PERIODS} report periods.`,
      );
    }

    const periodStartKey = getPeriodStartBusinessDate(cursor, args.granularity);
    const nextBoundaryKey = getNextPeriodStartBusinessDate(
      periodStartKey,
      args.granularity,
    );
    const endKey =
      nextBoundaryKey < args.endBusinessDateExclusive
        ? nextBoundaryKey
        : args.endBusinessDateExclusive;

    periods.push({
      key: getPeriodKey(periodStartKey, args.granularity),
      start: businessDateToUtcStart(cursor),
      end: businessDateToUtcStart(endKey),
      goalDays: countBusinessDays(cursor, endKey),
    });

    cursor = endKey;
  }

  return periods;
}

function getPeriodStartBusinessDate(
  dateKey: string,
  granularity: ReportGranularity,
): string {
  switch (granularity) {
    case "day":
      parseBusinessDateKey(dateKey);
      return dateKey;
    case "week":
      return startOfBusinessIsoWeek(dateKey);
    case "month": {
      const { year, month } = parseBusinessDateKey(dateKey);
      return formatUtcDateKey(year, month, 1);
    }
  }
}

function getNextPeriodStartBusinessDate(
  periodStartKey: string,
  granularity: ReportGranularity,
): string {
  switch (granularity) {
    case "day":
      return addBusinessDays(periodStartKey, 1);
    case "week":
      return addBusinessDays(periodStartKey, 7);
    case "month": {
      const { year, month } = parseBusinessDateKey(periodStartKey);
      const next = new Date(Date.UTC(year, month, 1));
      return formatUtcDateKey(
        next.getUTCFullYear(),
        next.getUTCMonth() + 1,
        next.getUTCDate(),
      );
    }
  }
}

function getPeriodKey(
  periodStartKey: string,
  granularity: ReportGranularity,
): string {
  switch (granularity) {
    case "day":
      return periodStartKey;
    case "week": {
      const { week, year } = getIsoWeekInfo(periodStartKey);
      return `${year}-W${pad2(week)}`;
    }
    case "month": {
      const { year, month } = parseBusinessDateKey(periodStartKey);
      return `${year}-${pad2(month)}`;
    }
  }
}

function startOfBusinessIsoWeek(dateKey: string): string {
  const { year, month, day } = parseBusinessDateKey(dateKey);
  const date = new Date(Date.UTC(year, month - 1, day));
  const utcDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (utcDay - 1));
  return formatUtcDateKey(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function getIsoWeekInfo(dateKey: string): { week: number; year: number } {
  const { year, month, day } = parseBusinessDateKey(dateKey);
  const date = new Date(Date.UTC(year, month - 1, day));
  const utcDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - utcDay);

  const weekYear = date.getUTCFullYear();
  const yearStart = Date.UTC(weekYear, 0, 1);
  const week = Math.ceil((date.getTime() - yearStart + DAY_MS) / (7 * DAY_MS));
  return { week, year: weekYear };
}

function parseBusinessDateKey(dateKey: string): {
  year: number;
  month: number;
  day: number;
} {
  if (!BUSINESS_DATE_PATTERN.test(dateKey)) {
    throw new Error("Invalid business date. Expected YYYY-MM-DD.");
  }

  const [yearRaw, monthRaw, dayRaw] = dateKey.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error("Invalid business date. Expected a real calendar day.");
  }

  return { year, month, day };
}

function formatUtcDateKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
