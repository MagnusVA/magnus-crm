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
import { OperationsReportSnapshotTable } from "../../_components/report-snapshot-table";
import {
	useOperationsDashboardReport,
	useOperationsReportRows,
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
	const teams = useQuery(api.leadGen.workers.listTeams, {
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
	const workerSnapshot = useOperationsReportRows({
		jobId: snapshot.jobId,
		section: "lead_gen_worker",
		enabled: snapshot.summary !== undefined,
	});
	const teamSnapshot = useOperationsReportRows({
		jobId: snapshot.jobId,
		section: "lead_gen_team",
		enabled: snapshot.summary !== undefined,
	});
	const sourceSnapshot = useOperationsReportRows({
		jobId: snapshot.jobId,
		section: "lead_gen_source",
		enabled: snapshot.summary !== undefined,
	});
	const originSnapshot = useOperationsReportRows({
		jobId: snapshot.jobId,
		section: "lead_gen_origin",
		enabled: snapshot.summary !== undefined,
	});

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
					state={snapshot.job?.status ?? (snapshot.requestError ? "failed" : "queued")}
					generatedAt={snapshot.summary?.generatedAt ?? null}
					errorMessage={snapshot.requestError ?? snapshot.job?.failure?.message ?? null}
					onCancel={() => void snapshot.cancel()}
					onRefresh={snapshot.refresh}
					onRetry={snapshot.retry}
				/>
			) : null}

			{snapshot.summary ? (
				<>
					<OperationsReportSnapshotTable
						title="Historical lead-gen summary"
						description={`Materialized for ${rangeLabel}.`}
						columns={[
							{ key: "submissions", label: "Submissions", align: "right" },
							{ key: "uniqueProspects", label: "Unique prospects", align: "right" },
							{ key: "duplicates", label: "Duplicates", align: "right" },
							{ key: "scheduledHours", label: "Scheduled hours", align: "right" },
							{ key: "leadsPerHour", label: "Leads/hour", align: "right" },
						]}
						rows={[{ rowKey: "main", payload: snapshot.summary.payload }]}
					/>
					<OperationsReportSnapshotTable
						title="Specialist performance"
						description="Completed historical report; use the arrows to page through specialists."
						columns={[
							{ key: "label", label: "Specialist" },
							{ key: "submissions", label: "Submissions", align: "right" },
							{ key: "uniqueProspects", label: "Unique prospects", align: "right" },
							{ key: "scheduledHours", label: "Scheduled hours", align: "right" },
							{ key: "leadsPerHour", label: "Leads/hour", align: "right" },
						]}
						rows={workerSnapshot.rows}
						isLoading={workerSnapshot.isLoading}
						hasPreviousPage={workerSnapshot.hasPreviousPage}
						hasNextPage={workerSnapshot.hasNextPage}
						onPreviousPage={workerSnapshot.previousPage}
						onNextPage={workerSnapshot.nextPage}
					/>
					<OperationsReportSnapshotTable
						title="Team performance"
						description="Completed historical report; use the arrows to page through teams."
						columns={[
							{ key: "label", label: "Team" },
							{ key: "submissions", label: "Submissions", align: "right" },
							{ key: "uniqueProspects", label: "Unique prospects", align: "right" },
							{ key: "scheduledHours", label: "Scheduled hours", align: "right" },
							{ key: "leadsPerHour", label: "Leads/hour", align: "right" },
						]}
						rows={teamSnapshot.rows}
						isLoading={teamSnapshot.isLoading}
						hasPreviousPage={teamSnapshot.hasPreviousPage}
						hasNextPage={teamSnapshot.hasNextPage}
						onPreviousPage={teamSnapshot.previousPage}
						onNextPage={teamSnapshot.nextPage}
					/>
					<OperationsReportSnapshotTable
						title="Source performance"
						description="Completed historical report by source."
						columns={[
							{ key: "source", label: "Source" },
							{ key: "submissions", label: "Submissions", align: "right" },
							{ key: "uniqueProspects", label: "Unique prospects", align: "right" },
							{ key: "leadsPerHour", label: "Leads/hour", align: "right" },
						]}
						rows={sourceSnapshot.rows}
						isLoading={sourceSnapshot.isLoading}
						hasPreviousPage={sourceSnapshot.hasPreviousPage}
						hasNextPage={sourceSnapshot.hasNextPage}
						onPreviousPage={sourceSnapshot.previousPage}
						onNextPage={sourceSnapshot.nextPage}
					/>
					<OperationsReportSnapshotTable
						title="Top origins"
						description="Completed historical report; use the arrows to page through origins."
						columns={[
							{ key: "originValue", label: "Origin" },
							{ key: "source", label: "Source" },
							{ key: "submissions", label: "Submissions", align: "right" },
							{ key: "uniqueProspects", label: "Unique prospects", align: "right" },
						]}
						rows={originSnapshot.rows}
						isLoading={originSnapshot.isLoading}
						hasPreviousPage={originSnapshot.hasPreviousPage}
						hasNextPage={originSnapshot.hasNextPage}
						onPreviousPage={originSnapshot.previousPage}
						onNextPage={originSnapshot.nextPage}
					/>
				</>
			) : null}

			{overview !== undefined && !overview.capped ? (
				<>
					<LeadGenSummaryCards
						data={overview}
						specialistCount={specialistRows?.length}
					/>
					<SpecialistPerformanceTable rows={specialistRows} teams={teams} />
					<TopOriginsTable rows={origins} />
				</>
			) : null}

			<RawSubmissionsTable filters={filters} />
		</div>
	);
}
