import { businessDateForInstant, type BusinessDaySetting } from "@/lib/businessDay";
import { formatBusinessDate } from "@/app/workspace/closer/_components/today-time";

// Dates in the deal modal: a day is the business day it falls on, "Oct 28"
// (DESIGN.md, The Business Day Rule, as on the person page); a time is in
// the tenant's time zone, "Oct 28, 4:30 PM". The year shows only when it
// isn't this year's.

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

function sameYear(ms: number, now: number, timeZone: string) {
  const year = formatter(timeZone, { year: "numeric" });
  return year.format(ms) === year.format(now);
}

/** "Oct 28", or "Oct 28, 2025" in another year: the business day `ms` falls on. */
export function formatDealDate(ms: number, setting: BusinessDaySetting, now: number) {
  const day = businessDateForInstant(ms, setting);
  const sameYear = day.slice(0, 4) === businessDateForInstant(now, setting).slice(0, 4);
  return formatBusinessDate(
    day,
    sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  );
}

/** "Oct 28, 4:30 PM", or "Oct 28, 2025, 4:30 PM" in another year. */
export function formatDealDateTime(ms: number, timeZone: string, now: number) {
  return formatter(timeZone, {
    month: "short",
    day: "numeric",
    ...(sameYear(ms, now, timeZone) ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
}
