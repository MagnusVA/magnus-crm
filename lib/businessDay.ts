export type BusinessDaySetting = { timeZone: string; dayStartHour: number };
export const DEFAULT_BUSINESS_DAY: BusinessDaySetting = {
  timeZone: "America/Tegucigalpa",
  dayStartHour: 1,
};
export type BusinessGranularity = "day" | "week" | "month";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function validateBusinessDay(setting: BusinessDaySetting) {
  if (!Number.isInteger(setting.dayStartHour) || setting.dayStartHour < 0 || setting.dayStartHour > 23) {
    throw new Error("Start hour must be an integer from 0 to 23.");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: setting.timeZone }).format(0);
  } catch {
    throw new Error("Choose a valid IANA time zone.");
  }
}

export function calendarDate(dateKey: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error("Invalid business date. Expected YYYY-MM-DD.");
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateKey) {
    throw new Error("Invalid business date. Expected a real calendar day.");
  }
  return date;
}

/** Calendar-label arithmetic, independent of DST and the length of a day. */
export function addBusinessDays(dateKey: string, days: number): string {
  if (!Number.isInteger(days)) throw new Error("Business-day offset must be an integer.");
  const date = calendarDate(dateKey);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function countBusinessDays(start: string, endExclusive: string): number {
  const count = (calendarDate(endExclusive).getTime() - calendarDate(start).getTime()) / DAY;
  if (count <= 0) throw new Error("End business date must be after start business date.");
  return count;
}

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
}

function wallTime(ms: number, format: Intl.DateTimeFormat): number {
  const values: Record<string, number> = {};
  for (const part of format.formatToParts(ms)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const date = new Date(0);
  date.setUTCFullYear(values.year, values.month - 1, values.day);
  date.setUTCHours(values.hour, values.minute, values.second, 0);
  return date.getTime();
}

/** Overlaps use the first occurrence. Gaps use the first instant after the gap. */
export function businessDayStart(dateKey: string, setting: BusinessDaySetting = DEFAULT_BUSINESS_DAY): number {
  validateBusinessDay(setting);
  const target = calendarDate(dateKey).getTime() + setting.dayStartHour * HOUR;
  const format = formatter(setting.timeZone);
  const offsets = new Set<number>();
  // Read both sides of any transition near this civil date, including date-line changes.
  for (let h = -48; h <= 48; h += 12) {
    const at = target + h * HOUR;
    offsets.add(wallTime(at, format) - at);
  }
  const candidates = [...offsets].map(offset => target - offset).sort((a, b) => a - b);
  const exact = candidates.find(at => wallTime(at, format) === target);
  if (exact !== undefined) return exact;
  let low = candidates[0];
  let high = candidates[candidates.length - 1];
  // The target lies in a forward clock jump. Find the transition itself rather
  // than shifting by an hour (some zones jump by thirty minutes or a full day).
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (wallTime(mid, format) >= target) high = mid;
    else low = mid;
  }
  return high;
}

export function businessDateForInstant(ms: number, setting: BusinessDaySetting = DEFAULT_BUSINESS_DAY): string {
  if (!Number.isFinite(ms)) throw new Error("Invalid timestamp.");
  const localDate = new Date(wallTime(ms, formatter(setting.timeZone))).toISOString().slice(0, 10);
  return ms < businessDayStart(localDate, setting) ? addBusinessDays(localDate, -1) : localDate;
}

export function businessDayRange(dateKey: string, setting: BusinessDaySetting = DEFAULT_BUSINESS_DAY) {
  return { start: businessDayStart(dateKey, setting), end: businessDayStart(addBusinessDays(dateKey, 1), setting) };
}

export function businessPeriodDate(dateKey: string, granularity: BusinessGranularity): string {
  const date = calendarDate(dateKey);
  if (granularity === "week") return addBusinessDays(dateKey, -((date.getUTCDay() + 6) % 7));
  return granularity === "month" ? `${dateKey.slice(0, 7)}-01` : dateKey;
}

export function nextBusinessPeriodDate(dateKey: string, granularity: BusinessGranularity): string {
  const start = businessPeriodDate(dateKey, granularity);
  if (granularity !== "month") return addBusinessDays(start, granularity === "day" ? 1 : 7);
  const date = calendarDate(start);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

export function businessPeriodKey(dateKey: string, granularity: BusinessGranularity): string {
  const start = businessPeriodDate(dateKey, granularity);
  if (granularity === "day") return start;
  if (granularity === "month") return start.slice(0, 7);
  const thursday = calendarDate(addBusinessDays(start, 3));
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - calendarDate(`${year}-01-01`).getTime()) / DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function businessPeriodRange(dateKey: string, granularity: BusinessGranularity, setting: BusinessDaySetting = DEFAULT_BUSINESS_DAY) {
  const start = businessPeriodDate(dateKey, granularity);
  return { start: businessDayStart(start, setting), end: businessDayStart(nextBusinessPeriodDate(start, granularity), setting) };
}

export function businessDayHourLabel(setting: BusinessDaySetting = DEFAULT_BUSINESS_DAY) {
  const hour = setting.dayStartHour;
  return `${hour % 12 || 12}:00 ${hour < 12 ? "am" : "pm"}`;
}
export function businessDayDisclosure(setting: BusinessDaySetting = DEFAULT_BUSINESS_DAY) {
  const hour = businessDayHourLabel(setting);
  return `Days run ${hour} to ${hour}, ${setting.timeZone} time`;
}
export function businessDayBoundaryText(setting: BusinessDaySetting = DEFAULT_BUSINESS_DAY) {
  return `Business days from ${businessDayHourLabel(setting)}, ${setting.timeZone}`;
}
export const BUSINESS_DAY_REBUILD_MESSAGE = "Day totals are being rebuilt after a business day change.";
