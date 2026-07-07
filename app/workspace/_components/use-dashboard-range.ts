"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { DashboardRangeInput } from "./dashboard-date-range-filter";
import {
	businessDateToCalendarDate,
	validateCustomDashboardRange,
} from "./dashboard-date-utils";

const DEFAULT_RANGE: DashboardRangeInput = {
	kind: "preset",
	preset: "today",
};

const PRESET_LABELS: Record<
	Extract<DashboardRangeInput, { kind: "preset" }>["preset"],
	string
> = {
	today: "Today",
	this_week: "This week",
	this_month: "This month",
};

function formatCustomRangeLabel(
	startBusinessDate: string,
	endBusinessDateInclusive: string,
) {
	const start = businessDateToCalendarDate(startBusinessDate);
	const end = businessDateToCalendarDate(endBusinessDateInclusive);
	const endLabel = end.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
	if (startBusinessDate === endBusinessDateInclusive) {
		return endLabel;
	}
	const startLabel = start.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		...(start.getFullYear() === end.getFullYear() ? {} : { year: "numeric" }),
	});
	return `${startLabel} – ${endLabel}`;
}

function parseRangeFromSearchParams(params: {
	get(name: string): string | null;
}): DashboardRangeInput | null {
	const raw = params.get("range");
	if (raw === "today" || raw === "this_week" || raw === "this_month") {
		return { kind: "preset", preset: raw };
	}
	if (raw === "custom") {
		const from = params.get("from");
		const to = params.get("to");
		if (
			from &&
			to &&
			validateCustomDashboardRange({
				startBusinessDate: from,
				endBusinessDateInclusive: to,
			}) === null
		) {
			return {
				kind: "custom",
				startBusinessDate: from,
				endBusinessDateInclusive: to,
			};
		}
	}
	return null;
}

export type UseDashboardRangeOptions = {
	/**
	 * When true, the committed range is persisted to the URL
	 * (`?range=today|this_week|this_month` or
	 * `?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`) and initialized from it
	 * on mount, so pages are shareable and refresh-safe.
	 */
	urlSync?: boolean;
	/** Range used when there is no (valid) URL state. Defaults to `today`. */
	defaultRange?: DashboardRangeInput;
};

export type UseDashboardRangeResult = {
	/** The current UI selection, including in-progress invalid custom ranges. */
	range: DashboardRangeInput;
	/** Pass to `DashboardDateRangeFilter`'s `onChange`. */
	setRange: (next: DashboardRangeInput) => void;
	/** The last valid selection — safe to send to Convex queries. */
	queryRange: DashboardRangeInput;
	/** Human-readable label for the committed range. */
	rangeLabel: string;
	/** Pass to `DashboardDateRangeFilter`'s `validationMessage`. */
	validationMessage: string | null;
};

/**
 * Shared Day / Week / Month / Custom range state for dashboard-style pages.
 *
 * Mirrors the overview pattern in `dashboard-page-client.tsx`: `range` tracks
 * the UI selection while `queryRange` only commits on presets or custom
 * ranges that pass `validateCustomDashboardRange`. Designed to plug straight
 * into the existing `DashboardDateRangeFilter` component.
 */
export function useDashboardRange(
	options: UseDashboardRangeOptions = {},
): UseDashboardRangeResult {
	const { urlSync = false, defaultRange = DEFAULT_RANGE } = options;
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();

	const [range, setRangeState] = useState<DashboardRangeInput>(
		() =>
			(urlSync ? parseRangeFromSearchParams(searchParams) : null) ??
			defaultRange,
	);
	const [queryRange, setQueryRange] = useState<DashboardRangeInput>(range);

	const setRange = useCallback(
		(next: DashboardRangeInput) => {
			setRangeState(next);
			const isCommittable =
				next.kind === "preset" ||
				validateCustomDashboardRange({
					startBusinessDate: next.startBusinessDate,
					endBusinessDateInclusive: next.endBusinessDateInclusive,
				}) === null;
			if (!isCommittable) {
				return;
			}
			setQueryRange(next);
			if (!urlSync) {
				return;
			}
			const params = new URLSearchParams(searchParams.toString());
			if (next.kind === "preset") {
				params.set("range", next.preset);
				params.delete("from");
				params.delete("to");
			} else {
				params.set("range", "custom");
				params.set("from", next.startBusinessDate);
				params.set("to", next.endBusinessDateInclusive);
			}
			router.replace(`${pathname}?${params.toString()}`, { scroll: false });
		},
		[urlSync, searchParams, pathname, router],
	);

	const validationMessage =
		range.kind === "custom"
			? validateCustomDashboardRange({
					startBusinessDate: range.startBusinessDate,
					endBusinessDateInclusive: range.endBusinessDateInclusive,
				})
			: null;

	const rangeLabel = useMemo(() => {
		if (queryRange.kind === "preset") {
			return PRESET_LABELS[queryRange.preset];
		}
		return formatCustomRangeLabel(
			queryRange.startBusinessDate,
			queryRange.endBusinessDateInclusive,
		);
	}, [queryRange]);

	return { range, setRange, queryRange, rangeLabel, validationMessage };
}
