"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { useRole } from "@/components/auth/role-context";
import {
	DashboardDateRangeFilter,
	type DashboardRangeInput,
} from "./dashboard-date-range-filter";
import { validateCustomDashboardRange } from "./dashboard-date-utils";
import { OverviewTopCards } from "./overview-top-cards";
import { PhoneCloserOperationsSection } from "./phone-closer-operations-section";
import { TopOriginsOverviewSection } from "./top-origins-overview-section";
import { OverviewDashboardSkeleton } from "./skeletons/overview-dashboard-skeleton";

export function DashboardPageClient() {
	usePageTitle("Overview");
	const { isAdmin } = useRole();
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
	const overview = useQuery(
		api.dashboard.overview.getOverviewDashboard,
		isAdmin ? { range: queryRange } : "skip",
	);

	if (!isAdmin || !overview) {
		return <OverviewDashboardSkeleton />;
	}

	return (
		<div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5">
			<header className="flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-end lg:justify-between">
				<div className="min-w-0">
					<h1 className="text-2xl font-semibold tracking-normal">Overview</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						{overview.range.label}
					</p>
				</div>
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
			</header>

			<OverviewTopCards overview={overview} />
			<PhoneCloserOperationsSection section={overview.phoneCloserOperations} />
			<TopOriginsOverviewSection section={overview.topOrigins} />
		</div>
	);
}
