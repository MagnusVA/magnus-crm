import { businessDateForInstant, type BusinessDaySetting } from "@/lib/businessDay";
import { formatClock, formatDateTime } from "@/app/workspace/closer/_components/today-time";
import { formatDecimal } from "@/app/workspace/_components/overview-formatters";

// Words and figures the Qualifications desk shares between its panes.

/** "4:44 PM" on today's business day, "Nov 1, 4:44 PM" before it, in the tenant's time zone. */
export function eventTime(at: number, now: number, setting: BusinessDaySetting) {
  const sameDay = businessDateForInstant(at, setting) === businessDateForInstant(now, setting);
  return sameDay ? formatClock(at, setting.timeZone) : formatDateTime(at, setting.timeZone);
}

/** Qualified per scheduled hour at one decimal, as Overview's Top Qualifiers reads it; null means no schedule. */
export function formatPerHour(rate: number) {
  return formatDecimal(rate, 1);
}

/** "instagram" → "Instagram", "other_social" → "Other social". */
export function platformLabel(platform: string) {
  const words = platform.split("_").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "mapped" → "Mapped", "needs_review" → "Needs review". */
export function sentenceCase(value: string) {
  return platformLabel(value);
}
