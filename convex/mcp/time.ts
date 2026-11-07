import { businessDayStart } from "../../lib/businessDay";
import { rejectRequest } from "../lib/observability/errors";

/**
 * Times the agent sees and sends are local to the user (§5.9): a result names
 * the zone, and a write reads back the instant it resolved.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string, withDate: boolean) {
  const key = `${timeZone}:${withDate}`;
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      ...(withDate ? { weekday: "short", day: "numeric", month: "short" } : {}),
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    formatters.set(key, format);
  }
  return format;
}

/** "Tue, Nov 3, 9:00 AM CST". */
export function formatLocal(ms: number, timeZone: string): string {
  return formatter(timeZone, true).format(ms);
}

/** "9:00 AM CST". */
export function formatLocalTime(ms: number, timeZone: string): string {
  return formatter(timeZone, false).format(ms);
}

/** "2026-11-04" in the zone. */
export function localDateKey(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Reads a local date ("2026-11-04") and time ("16:00") in the zone. Refuses
 * anything else, so a model that sends an offset or a sentence gets a
 * message it can act on.
 */
export function parseLocalDateTime(date: string, time: string, timeZone: string): number {
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!dateOk || !match) {
    throw rejectRequest(
      "time.invalid",
      'Send the date as "YYYY-MM-DD" and the time as "HH:MM", 24-hour, in the closer\'s local time, with no offset.',
    );
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw rejectRequest("time.invalid", 'The time must be between "00:00" and "23:59".');
  }
  return businessDayStart(date, { timeZone, dayStartHour: hour }) + minute * 60_000;
}
