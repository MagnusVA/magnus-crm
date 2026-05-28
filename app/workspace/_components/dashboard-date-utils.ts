const DAY_MS = 24 * 60 * 60 * 1000;
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_DASHBOARD_CUSTOM_DAYS = 120;

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
