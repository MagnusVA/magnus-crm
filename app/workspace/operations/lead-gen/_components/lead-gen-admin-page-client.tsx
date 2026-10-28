"use client";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { SettingsIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { dashboardRangeToAnalyticsRange } from "@/lib/analyticsRange";
import { businessDateForInstant } from "@/lib/businessDay";
import { AnalyticsFreshnessLine } from "@/app/workspace/_components/analytics/analytics-freshness";
import {
	useAnalyticsReport,
	useAnalyticsSource,
} from "@/app/workspace/_components/analytics/use-analytics-report";
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
import {
	leadDashboardOverview,
	leadDashboardWorkers,
	leadDashboardTeams,
	leadDashboardOriginsByTeam,
	sortLeadDashboardOriginTeams,
} from "@/lib/operations-reports/lead-dashboard";
import {
	useOperationsDashboardReport,
	useAllOperationsReportRows,
} from "../../_components/use-operations-report-job";
import { LeadGenFilterBar } from "./lead-gen-filter-bar";
import { LeadGenSummaryCards } from "./lead-gen-summary-cards";
import { ResparkPerformanceTable } from "./respark-performance-table";
import { ProspectConversionTable } from "./prospect-conversion-table";
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
 const { setting, rebuilding, loaded } = useBusinessDay("lead-gen");
 const now = useNow();
	const { range, setRange, queryRange, rangeLabel, validationMessage } =
		useDashboardRange({
			urlSync: true,
			defaultRange: { kind: "preset", preset: "today" },
			validationOptions: OPERATIONS_DASHBOARD_RANGE_VALIDATION,
		});
	const [source, setSource] = useState<LeadGenSource | undefined>(undefined);

	const filters = useMemo<LeadGenFilters>(() => {
		const dayKeys = dashboardRangeToDayKeys(queryRange, now, setting);
		return { ...dayKeys, ...(source ? { source } : {}) };
	}, [queryRange, source, now, setting]);
	const requiresSnapshot = useMemo(
		() => requiresOperationsReportSnapshot(queryRange, setting, now),
		[queryRange, now, setting],
	);

	// Today reads Convex live; any other range reads ClickHouse once the page
	// is switched (docs/plans/clickhouse-reporting.md §4), and then needs no
	// snapshot job. Until then the readers and the snapshot path answer.
	const analyticsRange = dashboardRangeToAnalyticsRange(
		queryRange,
		businessDateForInstant(now, setting),
	);
	const analyticsSource = useAnalyticsSource("lead_gen", analyticsRange);
	const warehouse = analyticsSource === "warehouse";
	const analyticsFilters = { source: source ?? null };

	const overviewReport = useAnalyticsReport({
		page: "lead_gen",
		reportId: "lead_gen.overview",
		range: analyticsRange,
		filters: analyticsFilters,
		live: api.leadGen.reporting.getOverview,
		liveArgs: !loaded || (!warehouse && (requiresSnapshot || rebuilding)) ? "skip" : filters,
	});
	const overview = overviewReport.data;
	const needsSnapshot =
		analyticsSource === "live" && (requiresSnapshot || overview?.capped === true);
	const teams = useQuery(api.leadGen.workers.listTeams, needsSnapshot ? "skip" : {
		includeInactive: true,
	});
	// Live, the tables wait for the overview to say the range isn't capped.
	const waitForOverview = !warehouse && (needsSnapshot || overview === undefined);
	const specialistReport = useAnalyticsReport({
		page: "lead_gen",
		reportId: "lead_gen.workers",
		range: analyticsRange,
		filters: analyticsFilters,
		live: api.leadGen.reporting.listWorkerPerformance,
		liveArgs: !loaded || waitForOverview ? "skip" : filters,
	});
	const specialistRows = specialistReport.data;
	const originsReport = useAnalyticsReport({
		page: "lead_gen",
		reportId: "lead_gen.top_origins_by_team",
		range: analyticsRange,
		filters: { ...analyticsFilters, limitPerTeam: 10, sortBy: "submissions" },
		live: api.leadGen.reporting.listTopOriginsByTeam,
		liveArgs: !loaded || waitForOverview
			? "skip"
			: { ...filters, limitPerTeam: 10, sortBy: "submissions" },
	});
	const origins = originsReport.data;
	const conversionsReport = useAnalyticsReport({
		page: "lead_gen",
		reportId: "lead_gen.prospect_conversions",
		range: analyticsRange,
		live: api.leadGen.conversions.listProspectConversions,
		liveArgs: !loaded ? "skip" : {
			startDayKey: filters.startDayKey,
			endDayKey: filters.endDayKey,
		},
	});
	const conversions = conversionsReport.data;
	const resparksReport = useAnalyticsReport({
		page: "lead_gen",
		reportId: "lead_gen.respark_performance",
		range: analyticsRange,
		filters: analyticsFilters,
		live: api.leadGen.resparkReports.listResparkPerformance,
		liveArgs: !loaded || (!warehouse && rebuilding) ? "skip" : filters,
	});
	const resparks = resparksReport.data;
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
		section: "lead_gen_team_origin",
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
		? originSnapshot.rows ? leadDashboardOriginsByTeam(originSnapshot.rows) : undefined
		: origins ? sortLeadDashboardOriginTeams(origins) : undefined, [needsSnapshot, originSnapshot.rows, origins]);
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
					<DashboardDateRangeFilter bucketKind="lead-gen"
						validationOptions={OPERATIONS_DASHBOARD_RANGE_VALIDATION}
						validationMessage={validationMessage}
						value={range}
						onChange={setRange}
					/>
					<AnalyticsFreshnessLine
						items={[
							overviewReport.freshness,
							specialistReport.freshness,
							originsReport.freshness,
							conversionsReport.freshness,
							resparksReport.freshness,
						]}
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
			<ProspectConversionTable report={conversions} />
			<ResparkPerformanceTable report={resparks} />
			<TopOriginsTable groups={displayOrigins} />

			<RawSubmissionsTable filters={filters} />
		</div>
	);
}
