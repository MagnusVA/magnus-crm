"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReportRangePreset } from "@/lib/analyticsRange";
import type { DashboardRangeInput } from "./dashboard-date-range-filter";
import { type DashboardRangePreset, RANGE_PRESET_LABELS } from "./date-range-picker";
import {
	businessDateToCalendarDate,
	type DashboardRangeValidationOptions,
	validateCustomDashboardRange,
} from "./dashboard-date-utils";

const DEFAULT_RANGE: DashboardRangeInput = {
	kind: "preset",
	preset: "today",
};
const DEFAULT_VALIDATION_OPTIONS: DashboardRangeValidationOptions = {};
const DASHBOARD_PRESETS: readonly DashboardRangePreset[] = ["today", "this_week", "this_month"];

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

/** A range from the URL, when it names one of `presets` or a valid custom range. */
export function parseRangeFromSearchParams<Preset extends ReportRangePreset>(
	params: { get(name: string): string | null },
	validationOptions: DashboardRangeValidationOptions,
	presets: readonly Preset[],
): DashboardRangeInput<Preset> | null {
	const raw = params.get("range");
	const preset = presets.find((entry) => entry === raw);
	if (preset !== undefined) {
		return { kind: "preset", preset };
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
			}, validationOptions) === null
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

export type UseDashboardRangeOptions<Preset extends ReportRangePreset = DashboardRangePreset> = {
	/**
	 * When true, the committed range is persisted to the URL
	 * (`?range=<preset>` or `?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`)
	 * and initialized from it on mount, so pages are shareable and
	 * refresh-safe.
	 */
	urlSync?: boolean;
	/**
	 * The presets the page offers, which the URL may name. Defaults to Today,
	 * This week and This month; Reports pass their longer list.
	 */
	presets?: readonly Preset[];
	/** Range used when there is no (valid) URL state. Defaults to `today`. */
	defaultRange?: DashboardRangeInput<Preset>;
	/** Keep the default policy for most dashboards; Operations permits jobs for long ranges. */
	validationOptions?: DashboardRangeValidationOptions;
};

export type UseDashboardRangeResult<Preset extends ReportRangePreset = DashboardRangePreset> = {
	/** The current UI selection, including in-progress invalid custom ranges. */
	range: DashboardRangeInput<Preset>;
	/** Pass to `DashboardDateRangeFilter`'s `onChange`. */
	setRange: (next: DashboardRangeInput<Preset>) => void;
	/**
	 * The last valid selection, preset names kept for labels. Send a live
	 * Convex reader `resolveDashboardRange(queryRange, todayBusinessDate)`
	 * (lib/analyticsRange.ts) instead: a preset resolved on the server would
	 * keep answering for the day the query first ran.
	 */
	queryRange: DashboardRangeInput<Preset>;
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
export function useDashboardRange<Preset extends ReportRangePreset = DashboardRangePreset>(
	options: UseDashboardRangeOptions<Preset> = {},
): UseDashboardRangeResult<Preset> {
	const {
		urlSync = false,
		// The defaults are dashboard presets, which every preset list includes.
		presets = DASHBOARD_PRESETS as readonly Preset[],
		defaultRange = DEFAULT_RANGE as DashboardRangeInput<Preset>,
		validationOptions = DEFAULT_VALIDATION_OPTIONS,
	} = options;
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();

	const [range, setRangeState] = useState<DashboardRangeInput<Preset>>(
		() =>
			(urlSync
				? parseRangeFromSearchParams(searchParams, validationOptions, presets)
				: null) ??
			defaultRange,
	);
	const [queryRange, setQueryRange] = useState<DashboardRangeInput<Preset>>(range);

	const setRange = useCallback(
		(next: DashboardRangeInput<Preset>) => {
			setRangeState(next);
			const isCommittable =
				next.kind === "preset" ||
				validateCustomDashboardRange({
					startBusinessDate: next.startBusinessDate,
					endBusinessDateInclusive: next.endBusinessDateInclusive,
				}, validationOptions) === null;
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
		[urlSync, searchParams, pathname, router, validationOptions],
	);

	const validationMessage =
		range.kind === "custom"
			? validateCustomDashboardRange({
					startBusinessDate: range.startBusinessDate,
					endBusinessDateInclusive: range.endBusinessDateInclusive,
				}, validationOptions)
			: null;

	const rangeLabel = useMemo(() => {
		if (queryRange.kind === "preset") {
			return RANGE_PRESET_LABELS[queryRange.preset];
		}
		return formatCustomRangeLabel(
			queryRange.startBusinessDate,
			queryRange.endBusinessDateInclusive,
		);
	}, [queryRange]);

	return {
		range,
		setRange,
		queryRange,
		rangeLabel,
		validationMessage,
	};
}
