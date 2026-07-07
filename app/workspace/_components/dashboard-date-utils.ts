import type { DashboardRangeInput } from "./dashboard-date-range-filter";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_DASHBOARD_CUSTOM_DAYS = 120;

// Honduras business days start at 01:00 local time (UTC-6, no DST), i.e.
// 07:00 UTC. Mirrors BUSINESS_DAY_UTC_START_HOUR in
// convex/reporting/lib/hondurasBusinessTime.ts so preset conversions below
// yield the same business days the server derives in
// convex/dashboard/overviewRange.ts.
const BUSINESS_DAY_UTC_START_HOUR = 7;

/** Current Honduras business-day key (YYYY-MM-DD) for a timestamp. */
export function timestampToBusinessDate(timestamp: number) {
	const shifted = new Date(timestamp - BUSINESS_DAY_UTC_START_HOUR * HOUR_MS);
	return [
		shifted.getUTCFullYear(),
		String(shifted.getUTCMonth() + 1).padStart(2, "0"),
		String(shifted.getUTCDate()).padStart(2, "0"),
	].join("-");
}

function startOfBusinessIsoWeek(dateKey: string) {
	const [year, month, day] = dateKey.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	const utcDay = date.getUTCDay() || 7;
	date.setUTCDate(date.getUTCDate() - (utcDay - 1));
	return date.toISOString().slice(0, 10);
}

/**
 * Converts a dashboard range selection into the inclusive
 * `startDayKey`/`endDayKey` business-day args that the `leadGen/reporting`
 * queries take. Custom ranges already carry business-date strings; presets
 * replicate `deriveOverviewRange` (convex/dashboard/overviewRange.ts):
 * today, Monday of the current ISO week, or the first of the current month,
 * each through the current Honduras business day.
 */
export function dashboardRangeToDayKeys(
	range: DashboardRangeInput,
	now: number = Date.now(),
): { startDayKey: string; endDayKey: string } {
	if (range.kind === "custom") {
		return {
			startDayKey: range.startBusinessDate,
			endDayKey: range.endBusinessDateInclusive,
		};
	}

	const today = timestampToBusinessDate(now);
	switch (range.preset) {
		case "today":
			return { startDayKey: today, endDayKey: today };
		case "this_week":
			return { startDayKey: startOfBusinessIsoWeek(today), endDayKey: today };
		case "this_month":
			return { startDayKey: `${today.slice(0, 7)}-01`, endDayKey: today };
	}
}

export function calendarDateToBusinessDate(date: Date) {
	return [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

export function businessDateToCalendarDate(dateKey: string) {
	const [year, month, day] = dateKey.split("-").map(Number);
	return new Date(year, month - 1, day);
}

export function countCalendarDaysInclusive(start: string, end: string) {
	if (!BUSINESS_DATE_PATTERN.test(start) || !BUSINESS_DATE_PATTERN.test(end)) {
		return null;
	}

	const startDate = businessDateToCalendarDate(start).getTime();
	const endDate = businessDateToCalendarDate(end).getTime();
	return Math.floor((endDate - startDate) / DAY_MS) + 1;
}

export function validateCustomDashboardRange(args: {
	startBusinessDate?: string;
	endBusinessDateInclusive?: string;
}) {
	if (!args.startBusinessDate || !args.endBusinessDateInclusive) {
		return "Choose a start and end date.";
	}
	if (args.startBusinessDate > args.endBusinessDateInclusive) {
		return "Choose an end date on or after the start date.";
	}

	const days = countCalendarDaysInclusive(
		args.startBusinessDate,
		args.endBusinessDateInclusive,
	);
	if (days === null) return "Choose valid calendar dates.";
	if (days > MAX_DASHBOARD_CUSTOM_DAYS) {
		return `Choose ${MAX_DASHBOARD_CUSTOM_DAYS} days or fewer.`;
	}

	return null;
}
