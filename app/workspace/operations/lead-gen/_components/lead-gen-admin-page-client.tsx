"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { SettingsIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { dashboardRangeToDayKeys } from "@/app/workspace/_components/dashboard-date-utils";
import { useDashboardRange } from "@/app/workspace/_components/use-dashboard-range";
import { LeadGenExportMenu } from "./lead-gen-export-menu";
import { LeadGenFilterBar } from "./lead-gen-filter-bar";
import { LeadGenSummaryCards } from "./lead-gen-summary-cards";
import { RawSubmissionsTable } from "./raw-submissions-table";
import { SpecialistPerformanceTable } from "./specialist-performance-table";
import { TopOriginsTable } from "./top-origins-table";

export type LeadGenSource = "instagram" | "meta_business";

export type LeadGenFilters = {
	startDayKey: string;
	endDayKey: string;
	source?: LeadGenSource;
};

export function LeadGenAdminPageClient() {
	const { range, setRange, queryRange, rangeLabel, validationMessage } =
		useDashboardRange({
			urlSync: true,
			defaultRange: { kind: "preset", preset: "this_week" },
		});
	const [source, setSource] = useState<LeadGenSource | undefined>(undefined);

	const filters = useMemo<LeadGenFilters>(() => {
		const dayKeys = dashboardRangeToDayKeys(queryRange);
		return { ...dayKeys, ...(source ? { source } : {}) };
	}, [queryRange, source]);

	const overview = useQuery(api.leadGen.reporting.getOverview, filters);
	const teams = useQuery(api.leadGen.workers.listTeams, {
		includeInactive: true,
	});
	const specialistRows = useQuery(
		api.leadGen.reporting.listWorkerPerformance,
		filters,
	);
	const origins = useQuery(api.leadGen.reporting.listTopOrigins, {
		...filters,
		limit: 10,
	});

	return (
		<div className="flex min-w-0 flex-col gap-4">
			<div className="sticky top-0 z-20 -mx-6 -mt-6 border-b bg-background/95 px-6 py-3 backdrop-blur supports-backdrop-filter:bg-background/80">
				<div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
					<div className="flex min-w-0 flex-col gap-1">
						<h1 className="text-xl font-semibold tracking-normal text-pretty">
							Lead Gen Ops
						</h1>
						<p className="max-w-3xl text-xs text-muted-foreground">
							Lead gen specialist activity, source quality, top origins,
							and operational exports.
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button asChild size="sm">
							<Link href="/workspace/lead-gen/settings">
								<SettingsIcon data-icon="inline-start" />
								Settings & Schedules
							</Link>
						</Button>
						<LeadGenExportMenu
							endDayKey={filters.endDayKey}
							source={filters.source}
							startDayKey={filters.startDayKey}
						/>
					</div>
				</div>
			</div>

			<LeadGenFilterBar
				range={range}
				rangeLabel={rangeLabel}
				source={source}
				validationMessage={validationMessage}
				onRangeChange={setRange}
				onSourceChange={setSource}
			/>

			<LeadGenSummaryCards
				data={overview}
				specialistCount={specialistRows?.length}
			/>

			<SpecialistPerformanceTable rows={specialistRows} teams={teams} />

			<TopOriginsTable rows={origins} />

			<RawSubmissionsTable filters={filters} />
		</div>
	);
}
