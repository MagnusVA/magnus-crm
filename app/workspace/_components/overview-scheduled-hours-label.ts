import type { DashboardRangeInput } from "./dashboard-date-range-filter";

type ScheduledHoursScopeLabel = "Day" | "Week" | "Month" | "Custom";

export function getScheduledHoursScopeLabel(
	range: DashboardRangeInput,
): ScheduledHoursScopeLabel {
	if (range.kind === "custom") {
		return "Custom";
	}

	switch (range.preset) {
		case "today":
			return "Day";
		case "this_week":
			return "Week";
		case "this_month":
			return "Month";
	}
}
