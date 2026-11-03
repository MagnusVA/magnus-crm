"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { dashboardRangePlan, dashboardRangeFromToday } from "@/lib/analyticsRange";
import {
	mergeLeadGenOverview,
	mergeLeadGenWorkers,
	mergeLeadGenTopOriginsByTeam,
	mergeLeadGenProspectConversions,
	mergeLeadGenResparkPerformance,
} from "@/convex/analytics/merge/leadGen";
import { businessDateForInstant, businessDayDisclosure } from "@/lib/businessDay";
import {
	AnalyticsFreshnessAlert,
	FreshnessWords,
	freshnessSummary,
} from "@/app/workspace/_components/analytics/analytics-freshness";
import {
	useAnalyticsReport,
	useAnalyticsSource,
} from "@/app/workspace/_components/analytics/use-analytics-report";
import {
	DateRangePicker,
	formatBusinessDateSpan,
	rangePhrase as rangePhraseOf,
} from "@/app/workspace/_components/date-range-picker";
import {
	dashboardRangeToDayKeys,
	OPERATIONS_DASHBOARD_RANGE_VALIDATION,
	requiresOperationsReportSnapshot,
} from "@/app/workspace/_components/dashboard-date-utils";
import { useDashboardRange } from "@/app/workspace/_components/use-dashboard-range";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
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
import { LeadGenBand } from "./lead-gen-band";
import { ProspectConversionSection } from "./prospect-conversion-section";
import { RawSubmissionsCard } from "./raw-submissions-card";
import { ResparkSection } from "./respark-section";
import { SpecialistsSection } from "./specialists-section";
import { TopPostsByTeam } from "./top-posts-by-team";
import { useKeptWhileLoading } from "./use-kept-while-loading";

export type LeadGenSource = "instagram" | "meta_business";

export type LeadGenFilters = {
	startDayKey: string;
	endDayKey: string;
	source?: LeadGenSource;
};

const PRESET_WORDS = { today: "Today", this_week: "This week", this_month: "This month" } as const;

const asOfFormatter = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

export function LeadGenAdminPageClient() {
	usePageTitle("Lead Gen");
	const { setting, rebuilding, loaded } = useBusinessDay("lead-gen");
	const now = useNow();
	const { range, setRange, queryRange, validationMessage } =
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

	// Today reads Convex live, and so does today's part of a longer range; the
	// days before today read ClickHouse once the page is switched, and then
	// need no snapshot job. Until then the readers and the snapshot path
	// answer (docs/agents/reporting.md).
	const todayBusinessDate = businessDateForInstant(now, setting);
	const plan = dashboardRangePlan(queryRange, todayBusinessDate);
	const analyticsSource = useAnalyticsSource("lead_gen", plan);
	const warehouse = analyticsSource === "warehouse";
	const analyticsFilters = { source: source ?? null };
	const todayFilters = {
		...dashboardRangeToDayKeys(
			dashboardRangeFromToday(queryRange, todayBusinessDate),
			now,
			setting,
		),
		...(source ? { source } : {}),
	};

	const overviewReport = useAnalyticsReport({
		page: "lead_gen",
		reportId: "lead_gen.overview",
		plan,
		filters: analyticsFilters,
		live: api.leadGen.reporting.getOverview,
		merge: mergeLeadGenOverview,
		todayArgs: !loaded || rebuilding ? "skip" : todayFilters,
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
		plan,
		filters: analyticsFilters,
		live: api.leadGen.reporting.listWorkerPerformance,
		merge: mergeLeadGenWorkers,
		todayArgs: !loaded || rebuilding || waitForOverview ? "skip" : todayFilters,
		liveArgs: !loaded || waitForOverview ? "skip" : filters,
	});
	const specialistRows = specialistReport.data;
	const originsReport = useAnalyticsReport({
		page: "lead_gen",
		reportId: "lead_gen.top_origins_by_team",
		plan,
		filters: { ...analyticsFilters, limitPerTeam: 10, sortBy: "submissions" },
		live: api.leadGen.reporting.listTopOriginsByTeam,
		merge: mergeLeadGenTopOriginsByTeam,
		todayArgs: !loaded || rebuilding || waitForOverview
			? "skip"
			: { ...todayFilters, limitPerTeam: 10, sortBy: "submissions" },
		liveArgs: !loaded || waitForOverview
			? "skip"
			: { ...filters, limitPerTeam: 10, sortBy: "submissions" },
	});
	const origins = originsReport.data;
	const conversionsReport = useAnalyticsReport({
		page: "lead_gen",
		reportId: "lead_gen.prospect_conversions",
		plan,
		live: api.leadGen.conversions.listProspectConversions,
		merge: mergeLeadGenProspectConversions,
		todayArgs: !loaded ? "skip" : {
			startDayKey: todayFilters.startDayKey,
			endDayKey: todayFilters.endDayKey,
		},
		liveArgs: !loaded ? "skip" : {
			startDayKey: filters.startDayKey,
			endDayKey: filters.endDayKey,
		},
	});
	const conversions = conversionsReport.data;
	const resparksReport = useAnalyticsReport({
		page: "lead_gen",
		reportId: "lead_gen.respark_performance",
		plan,
		filters: analyticsFilters,
		live: api.leadGen.resparkReports.listResparkPerformance,
		merge: mergeLeadGenResparkPerformance,
		todayArgs: !loaded || rebuilding ? "skip" : todayFilters,
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

	// Memoized like the rows below: the kept-data hook keeps each new object it sees.
	const snapshotPayload = snapshot.summary?.payload;
	const displayOverview = useMemo(() => needsSnapshot
		? snapshotPayload ? leadDashboardOverview(snapshotPayload) : undefined
		: overview, [needsSnapshot, snapshotPayload, overview]);
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

	// The range in words, from the business days the numbers cover.
	const phrase = rangePhraseOf(queryRange);
	const dates = formatBusinessDateSpan(filters.startDayKey, filters.endDayKey, todayBusinessDate);
	const rangeWords = queryRange.kind === "custom" ? dates : `${PRESET_WORDS[queryRange.preset]} · ${dates}`;
	const freshness = freshnessSummary(
		[
			overviewReport.freshness,
			specialistReport.freshness,
			originsReport.freshness,
			conversionsReport.freshness,
			resparksReport.freshness,
		],
		now,
	);

	// A new range or source keeps each section's last numbers on screen,
	// dimmed, until the new ones arrive (DESIGN.md, Kept Data While Reloading).
	const shownOverview = useKeptWhileLoading(displayOverview, phrase);
	const shownWorkers = useKeptWhileLoading(displayWorkers, phrase);
	const shownTeams = useKeptWhileLoading(displayTeams, phrase);
	const shownOrigins = useKeptWhileLoading(displayOrigins, phrase);
	const shownConversions = useKeptWhileLoading(conversions, phrase);
	const shownResparks = useKeptWhileLoading(resparks, phrase);

	const freshnessWords = needsSnapshot ? (
		<span role="status">
			{snapshot.summary
				? `Historical report as of ${asOfFormatter.format(new Date(snapshot.summary.generatedAt))}`
				: "Preparing the historical report"}
		</span>
	) : freshness.kind === "line" && shownOverview.data !== undefined ? (
		// Until the first numbers arrive the source isn't settled, so no "Live" yet.
		<FreshnessWords summary={freshness} />
	) : null;

	return (
		<div className="@container mx-auto flex w-full max-w-[1500px] flex-col gap-3.5 pb-6 short:gap-3">
			<LeadGenBand
				description={
					<>
						<span className="font-medium text-board-foreground">{rangeWords}</span>
						{freshnessWords ? <> · {freshnessWords}</> : null}
						<span className="hidden @3xl:inline"> · {businessDayDisclosure(setting)}</span>
						{validationMessage ? (
							<span className="mt-1 block text-board-danger" role="alert">
								{validationMessage}
							</span>
						) : null}
					</>
				}
				picker={
					<DateRangePicker
						tone="board"
						value={range}
						onChange={setRange}
						validationOptions={OPERATIONS_DASHBOARD_RANGE_VALIDATION}
						todayBusinessDate={todayBusinessDate}
					/>
				}
				exportMenu={
					<OperationsReportExportMenu
						reportKind="lead-gen"
						range={queryRange}
						sourceFilter={filters.source}
					/>
				}
				totals={shownOverview.data}
				specialistCount={shownWorkers.data?.length}
				rangePhrase={shownWorkers.phrase}
				reloading={shownOverview.reloading || shownWorkers.reloading}
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
			) : (
				<AnalyticsFreshnessAlert summary={freshness} />
			)}

			<ProspectConversionSection
				report={shownConversions.data}
				rangePhrase={shownConversions.phrase}
				reloading={shownConversions.reloading}
			/>

			<div className="grid items-start gap-3.5 @5xl:grid-cols-[minmax(0,1fr)_24rem] short:gap-3">
				<SpecialistsSection
					rows={shownWorkers.data}
					teams={shownTeams.data}
					conversions={shownConversions.data}
					allSources={source === undefined}
					rangePhrase={shownWorkers.phrase}
					reloading={shownWorkers.reloading}
				/>
				<TopPostsByTeam
					groups={shownOrigins.data}
					rangePhrase={shownOrigins.phrase}
					reloading={shownOrigins.reloading}
					todayBusinessDate={todayBusinessDate}
				/>
			</div>

			<ResparkSection
				report={shownResparks.data}
				rangePhrase={shownResparks.phrase}
				reloading={shownResparks.reloading}
			/>

			<RawSubmissionsCard filters={filters} />
		</div>
	);
}
