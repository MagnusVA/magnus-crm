import { v } from "convex/values";
import {
  businessDateForInstant, businessDayStart, businessPeriodDate,
  nextBusinessPeriodDate, businessPeriodKey, type BusinessDaySetting,
} from "../../../lib/businessDay";
export { addBusinessDays, countBusinessDays } from "../../../lib/businessDay";
import { countBusinessDays } from "../../../lib/businessDay";
export const HONDURAS_TIME_ZONE = "America/Tegucigalpa";
export const HONDURAS_UTC_OFFSET_HOURS = -6;
export const BUSINESS_DAY_START_HOUR = 1;
export const BUSINESS_DAY_UTC_START_HOUR = 7;
export type ReportGranularity = "day" | "week" | "month";
export const reportGranularityValidator = v.union(v.literal("day"), v.literal("week"), v.literal("month"));
export type BusinessPeriod = { key: string; start: number; end: number; goalDays: number };
const MAX_REPORT_PERIODS = 120;
export function businessDateToUtcStart(dateKey: string, setting?: BusinessDaySetting) {
  return businessDayStart(dateKey, setting);
}
export function timestampToBusinessDateKey(timestamp: number, setting?: BusinessDaySetting) {
  return businessDateForInstant(timestamp, setting);
}
export function buildBusinessPeriods(args: {
  startBusinessDate: string;
  endBusinessDateExclusive: string;
  granularity: ReportGranularity;
  setting?: BusinessDaySetting;
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

    const periodStartKey = businessPeriodDate(cursor, args.granularity);
    const nextBoundaryKey = nextBusinessPeriodDate(
      periodStartKey,
      args.granularity,
    );
    const endKey =
      nextBoundaryKey < args.endBusinessDateExclusive
        ? nextBoundaryKey
        : args.endBusinessDateExclusive;

    periods.push({
      key: businessPeriodKey(periodStartKey, args.granularity),
      start: businessDateToUtcStart(cursor, args.setting),
      end: businessDateToUtcStart(endKey, args.setting),
      goalDays: countBusinessDays(cursor, endKey),
    });

    cursor = endKey;
  }

  return periods;
}
