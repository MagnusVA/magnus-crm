"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { SettingsIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { DashboardDateRangeFilter } from "@/app/workspace/_components/dashboard-date-range-filter";
import {
	dashboardRangeToDayKeys,
	OPERATIONS_DASHBOARD_RANGE_VALIDATION,
	requiresOperationsReportSnapshot,
} from "@/app/workspace/_components/dashboard-date-utils";
import { useDashboardRange } from "@/app/workspace/_components/use-dashboard-range";
import { OperationsReportExportMenu } from "../../_components/operations-report-export-menu";
import { OperationsReportJobStatus } from "../../_components/report-job-status";
import { leadDashboardOverview, leadDashboardWorkers, leadDashboardTeams, leadDashboardOrigins } from "@/lib/operations-reports/lead-dashboard";
import {
	useOperationsDashboardReport,
	useAllOperationsReportRows,
} from "../../_components/use-operations-report-job";
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
			validationOptions: OPERATIONS_DASHBOARD_RANGE_VALIDATION,
		});
	const [source, setSource] = useState<LeadGenSource | undefined>(undefined);

	const filters = useMemo<LeadGenFilters>(() => {
		const dayKeys = dashboardRangeToDayKeys(queryRange);
		return { ...dayKeys, ...(source ? { source } : {}) };
	}, [queryRange, source]);
	const requiresSnapshot = useMemo(
		() => requiresOperationsReportSnapshot(queryRange),
		[queryRange],
	);

	const overview = useQuery(
		api.leadGen.reporting.getOverview,
		requiresSnapshot ? "skip" : filters,
	);
	const needsSnapshot = requiresSnapshot || overview?.capped === true;
	const teams = useQuery(api.leadGen.workers.listTeams, needsSnapshot ? "skip" : {
		includeInactive: true,
	});
	const specialistRows = useQuery(
		api.leadGen.reporting.listWorkerPerformance,
		needsSnapshot || overview === undefined ? "skip" : filters,
	);
	const origins = useQuery(
		api.leadGen.reporting.listTopOrigins,
		needsSnapshot || overview === undefined ? "skip" : { ...filters, limit: 10 },
	);
	const snapshot = useOperationsDashboardReport({
		reportKind: "lead-gen",
		range: queryRange,
		sourceFilter: filters.source,
		enabled: needsSnapshot,
	});
	const workerSnapshot = useAllOperationsReportRows({
		jobId: snapshot.jobId,
		section: "lead_gen_worker",
		enabled: snapshot.summary !== undefined,
	});
	const originSnapshot = useAllOperationsReportRows({
		jobId: snapshot.jobId,
		section: "lead_gen_origin",
		enabled: snapshot.summary !== undefined,
	});

	const displayOverview = needsSnapshot
		? snapshot.summary ? leadDashboardOverview(snapshot.summary.payload) : undefined
		: overview;
	const displayWorkers = useMemo(() => needsSnapshot
		? workerSnapshot.rows ? leadDashboardWorkers(workerSnapshot.rows) : undefined
		: specialistRows, [needsSnapshot, workerSnapshot.rows, specialistRows]);
	const displayTeams = useMemo(() => needsSnapshot
		? workerSnapshot.rows ? leadDashboardTeams(workerSnapshot.rows) : undefined
		: teams, [needsSnapshot, workerSnapshot.rows, teams]);
	const displayOrigins = useMemo(() => needsSnapshot
		? originSnapshot.rows ? leadDashboardOrigins(originSnapshot.rows) : undefined
		: origins, [needsSnapshot, originSnapshot.rows, origins]);
	const resultError = workerSnapshot.error ?? originSnapshot.error;

	return (
		<div className="flex min-w-0 flex-col gap-4">
			<header className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
				<div className="flex min-w-0 items-start gap-3">
					<div className="mt-[3px] h-7 w-[3px] shrink-0 rounded-full bg-primary/75" />
					<div className="min-w-0">
						<h1 className="text-2xl font-semibold tracking-tight">
							Lead Gen Ops
						</h1>
						<p className="mt-1 max-w-3xl text-sm text-muted-foreground">
							Lead gen specialist activity, source quality, top origins,
							and operational exports.
						</p>
					</div>
				</div>
				<div className="flex flex-col items-start gap-3 lg:items-end">
					<div className="flex flex-wrap items-center gap-2">
						<Button asChild size="sm">
							<Link href="/workspace/lead-gen/settings">
								<SettingsIcon data-icon="inline-start" />
								Settings & Schedules
							</Link>
						</Button>
						<OperationsReportExportMenu
							reportKind="lead-gen"
							range={queryRange}
							sourceFilter={filters.source}
						/>
					</div>
					<DashboardDateRangeFilter
						validationOptions={OPERATIONS_DASHBOARD_RANGE_VALIDATION}
						validationMessage={validationMessage}
						value={range}
						onChange={setRange}
					/>
				</div>
			</header>

			<LeadGenFilterBar
				rangeLabel={rangeLabel}
				source={source}
				onSourceChange={setSource}
			/>

			{needsSnapshot ? (
				<OperationsReportJobStatus
					state={resultError ? "failed" : snapshot.job?.status ?? (snapshot.requestError ? "failed" : "queued")}
					generatedAt={snapshot.summary?.generatedAt ?? null}
					errorMessage={resultError ?? snapshot.requestError ?? snapshot.job?.failure?.message ?? null}
					onCancel={() => void snapshot.cancel()}
					onRefresh={snapshot.refresh}
					onRetry={snapshot.retry}
				/>
			) : null}

			<LeadGenSummaryCards data={displayOverview} specialistCount={displayWorkers?.length} />
			<SpecialistPerformanceTable rows={displayWorkers} teams={displayTeams} />
			<TopOriginsTable rows={displayOrigins} />

			<RawSubmissionsTable filters={filters} />
		</div>
	);
}
