import { businessDateForInstant, type BusinessDaySetting } from "@/lib/businessDay";
import { formatBusinessDate } from "@/app/workspace/closer/_components/today-time";

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

/**
 * "Oct 25", or "Oct 25, 2025" when it isn't this year: the business day the
 * instant falls on (DESIGN.md; My Pipeline's `StepWords` reads days the same
 * way), so every date on the page agrees with the deal modal.
 */
export function personDate(ms: number, setting: BusinessDaySetting, now: number) {
  const day = businessDateForInstant(ms, setting);
  const sameYear = day.slice(0, 4) === businessDateForInstant(now, setting).slice(0, 4);
  return formatBusinessDate(
    day,
    sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  );
}

/** "Oct 25" this year, "10/25/25" before it, for the timeline's narrow date column. */
export function personShortDate(ms: number, setting: BusinessDaySetting, now: number) {
  const day = businessDateForInstant(ms, setting);
  const sameYear = day.slice(0, 4) === businessDateForInstant(now, setting).slice(0, 4);
  return formatBusinessDate(
    day,
    sameYear ? { month: "short", day: "numeric" } : { month: "numeric", day: "numeric", year: "2-digit" },
  );
}

/** "Oct 25, 4:30 PM", for a title attribute. */
export function personDateTime(ms: number, timeZone: string) {
  return formatter(timeZone, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
}

export function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}
