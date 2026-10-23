import {
  businessDateForInstant, businessDayStart, businessPeriodDate,
  businessPeriodKey, nextBusinessPeriodDate, type BusinessDaySetting,
} from "../../../lib/businessDay";
export type Granularity = "day" | "week" | "month";
export interface Period { key: string; start: number; end: number }
const MAX_PERIODS = 90;
export function getPeriodsInRange(startDate: number, endDate: number, granularity: Granularity, setting?: BusinessDaySetting): Period[] {
  if (!Number.isFinite(startDate) || !Number.isFinite(endDate) || endDate <= startDate) return [];
  const periods: Period[] = [];
  let date = businessPeriodDate(businessDateForInstant(startDate, setting), granularity);
  while (businessDayStart(date, setting) < endDate && periods.length < MAX_PERIODS) {
    const next = nextBusinessPeriodDate(date, granularity);
    const start = Math.max(startDate, businessDayStart(date, setting));
    const end = Math.min(endDate, businessDayStart(next, setting));
    if (start < end) periods.push({ key: businessPeriodKey(date, granularity), start, end });
    date = next;
  }
  return periods;
}
export function getPeriodKey(timestamp: number, granularity: Granularity, setting?: BusinessDaySetting) {
  return businessPeriodKey(businessDateForInstant(timestamp, setting), granularity);
}
