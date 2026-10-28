"use client";

import { useEffect, useState } from "react";
import posthog from "posthog-js";
import { api } from "@/convex/_generated/api";
import { dashboardRangeToAnalyticsRange } from "@/lib/analyticsRange";
import { businessDateForInstant } from "@/lib/businessDay";
import { AnalyticsFreshnessLine } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageTitle } from "@/hooks/use-page-title";
import { useRole } from "@/components/auth/role-context";
import {
	DashboardDateRangeFilter,
	type DashboardRangeInput,
} from "./dashboard-date-range-filter";
import { validateCustomDashboardRange } from "./dashboard-date-utils";
import type { OverviewDashboard } from "./overview-dashboard-types";
import { OverviewTopCards } from "./overview-top-cards";
import { PhoneCloserOperationsSection } from "./phone-closer-operations-section";
import { TopOriginsOverviewSection } from "./top-origins-overview-section";
import { OverviewDashboardSkeleton } from "./skeletons/overview-dashboard-skeleton";

type OverviewSectionKey = Exclude<keyof OverviewDashboard, "range">;

/**
 * Reports a section the backend marked `status: "error"`. The query returns
 * the failure instead of reporting it, because it re-runs on every update;
 * this reports once per mount for each section and error code.
 */
function useReportOverviewSectionError(
	key: OverviewSectionKey,
	section: OverviewDashboard[OverviewSectionKey] | undefined,
) {
	const errorCode = section?.status === "error" ? section.errorCode : null;
	useEffect(() => {
		if (errorCode === null) return;
		posthog.captureException(new Error(`Overview section failed: ${key}`), {
			error_origin: "dashboard_overview",
			section: key,
			error_code: errorCode,
		});
	}, [key, errorCode]);
}

export function DashboardPageClient() {
	usePageTitle("Overview");
	const { isAdmin } = useRole();
	const { loaded, setting } = useBusinessDay();
	const now = useNow();
	const [range, setRange] = useState<DashboardRangeInput>({
		kind: "preset",
		preset: "today",
	});
	const [queryRange, setQueryRange] = useState<DashboardRangeInput>({
		kind: "preset",
		preset: "today",
	});
	const rangeValidationMessage =
		range.kind === "custom"
			? validateCustomDashboardRange({
					startBusinessDate: range.startBusinessDate,
					endBusinessDateInclusive: range.endBusinessDateInclusive,
				})
			: null;
	// Today reads Convex live; any other range reads ClickHouse once the page
	// is switched (docs/plans/clickhouse-reporting.md §4).
	const analyticsRange = dashboardRangeToAnalyticsRange(
		queryRange,
		businessDateForInstant(now, setting),
	);
	const report = useAnalyticsReport({
		page: "overview",
		reportId: "overview.dashboard",
		range: analyticsRange,
		live: api.dashboard.overview.getOverviewDashboard,
		liveArgs: isAdmin && loaded ? { range: queryRange } : "skip",
	});
	const overview = report.data;
	useReportOverviewSectionError("leadGen", overview?.leadGen);
	useReportOverviewSectionError("topQualifiers", overview?.topQualifiers);
	useReportOverviewSectionError("topDmClosers", overview?.topDmClosers);
	useReportOverviewSectionError(
		"phoneCloserOperations",
		overview?.phoneCloserOperations,
	);
	useReportOverviewSectionError("topOrigins", overview?.topOrigins);

	// A ClickHouse range can take a while to load; keep the controls and its
	// status on screen instead of the full-page skeleton.
	if (!isAdmin || (!overview && report.source !== "warehouse")) {
		return <OverviewDashboardSkeleton />;
	}

	return (
		<div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 pb-6">
			<header className="flex flex-col gap-3 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
				<div className="flex min-w-0 items-start gap-3">
					<div className="mt-[3px] h-7 w-[3px] shrink-0 rounded-full bg-primary/75" />
					<div>
						<h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
						{overview ? (
							<p className="mt-1 text-sm text-muted-foreground">
								{overview.range.label}
							</p>
						) : (
							<Skeleton className="mt-1 h-4 w-40" />
						)}
					</div>
				</div>
				<div className="flex flex-col gap-2 lg:items-end">
					<DashboardDateRangeFilter
						value={range}
						onChange={(nextRange) => {
							setRange(nextRange);
							if (
								nextRange.kind === "preset" ||
								validateCustomDashboardRange({
									startBusinessDate: nextRange.startBusinessDate,
									endBusinessDateInclusive:
										nextRange.endBusinessDateInclusive,
								}) === null
							) {
								setQueryRange(nextRange);
							}
						}}
						validationMessage={rangeValidationMessage}
					/>
					<AnalyticsFreshnessLine items={[report.freshness]} />
				</div>
			</header>

			{overview ? (
				<>
					<OverviewTopCards overview={overview} queryRange={queryRange} />
					<PhoneCloserOperationsSection section={overview.phoneCloserOperations} />
					<TopOriginsOverviewSection section={overview.topOrigins} />
				</>
			) : (
				<div className="flex flex-col gap-5" aria-hidden="true">
					<Skeleton className="h-64 w-full rounded-lg" />
					<Skeleton className="h-[320px] w-full rounded-lg" />
					<Skeleton className="h-[360px] w-full rounded-lg" />
				</div>
			)}
		</div>
	);
}
