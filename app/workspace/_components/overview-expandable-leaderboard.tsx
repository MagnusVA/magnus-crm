"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { SectionErrorBoundary } from "./section-error-boundary";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import type { DashboardRangeInput } from "./dashboard-date-range-filter";
import { MemberAvatar } from "./member-avatar";
import { formatDecimal, formatWholeNumber } from "./overview-formatters";
import {
	OverviewHelpTooltip,
	overviewTooltips,
} from "./overview-help-tooltip";
import { getScheduledHoursScopeLabel } from "./overview-scheduled-hours-label";
import {
	OverviewCappedState,
	OverviewEmptyState,
	OverviewErrorState,
	OverviewTruncatedNote,
} from "./overview-section-state";

type LeaderboardKind = "lead_gen" | "qualifiers" | "dm_closers";
type ExpandedOverviewLeaderboard = FunctionReturnType<
	typeof api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows
>;

function ExpandedLeaderboardSkeleton() {
	return (
		<div
			className="flex h-64 flex-col gap-3"
			role="status"
			aria-label="Loading expanded leaderboard"
		>
			<Skeleton className="h-10 w-full" />
			<Skeleton className="h-10 w-full" />
			<Skeleton className="h-40 w-full" />
		</div>
	);
}

function ExpandedLeaderboardQuery({
	kind,
	range,
}: {
	kind: LeaderboardKind;
	range: DashboardRangeInput;
}) {
	const data = useQuery(
		api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows,
		{ kind, range },
	);

	if (data === undefined) {
		return <ExpandedLeaderboardSkeleton />;
	}

	if (data.cappedMessage) {
		return <OverviewCappedState message={data.cappedMessage} />;
	}

	if (data.rows.length === 0) {
		return <OverviewEmptyState message="No leaderboard rows for this range." />;
	}

	const scheduledHoursScopeLabel = getScheduledHoursScopeLabel(range);

	return (
		<>
			{data.truncated ? <OverviewTruncatedNote /> : null}
			<p className="text-xs text-muted-foreground">
				Showing all {formatWholeNumber(data.totalRows)}
			</p>
			<ExpandedLeaderboardRows
				data={data}
				scheduledHoursScopeLabel={scheduledHoursScopeLabel}
			/>
		</>
	);
}

function ExpandedLeaderboardRows({
	data,
	scheduledHoursScopeLabel,
}: {
	data: ExpandedOverviewLeaderboard;
	scheduledHoursScopeLabel: string;
}) {
	if (data.kind === "lead_gen") {
		return (
			<div className="flex flex-col gap-2">
				<div className="flex items-center justify-between px-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
					<OverviewHelpTooltip
						label="Lead generators"
						description={overviewTooltips.leadGen.topWorkers}
					>
						Lead generators
					</OverviewHelpTooltip>
					<OverviewHelpTooltip
						label="Leads per hour"
						description={overviewTooltips.leadGen.workerRate}
						triggerClassName="text-[10px] font-semibold uppercase tracking-wider"
					>
						Leads/hr
					</OverviewHelpTooltip>
				</div>
				<ol className="flex flex-col gap-0.5" aria-label="All lead generators">
					{data.rows.map((worker, index) => (
						<li
							key={worker.workerId}
							className="grid grid-cols-[1.25rem_auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded px-1.5 py-1.5 text-sm transition-colors hover:bg-muted/50"
						>
							<span className="text-center text-xs font-semibold tabular-nums text-muted-foreground/60">
								{index + 1}
							</span>
							<MemberAvatar
								identity={{
									id: worker.workerId,
									name: worker.displayName,
									source: "crm_user",
								}}
								size="sm"
							/>
							<div className="min-w-0">
								<p className="truncate font-medium">{worker.displayName}</p>
								<p className="truncate text-xs text-muted-foreground">
									{formatWholeNumber(worker.submissions)} submissions ·{" "}
									{`${formatDecimal(worker.scheduledHours)}h scheduled (${scheduledHoursScopeLabel})`}
								</p>
							</div>
							<span className="font-semibold tabular-nums">
								{formatDecimal(worker.leadsPerHour)}
							</span>
						</li>
					))}
				</ol>
			</div>
		);
	}

	if (data.kind === "qualifiers") {
		return (
			<div className="flex flex-col gap-2">
				<div className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
					<span aria-hidden="true" />
					<span>Qualifier</span>
					<OverviewHelpTooltip
						label="Qualified per hour"
						description={overviewTooltips.topQualifiers.qualifiedPerHour}
						triggerClassName="justify-end text-[10px] font-semibold uppercase tracking-wider"
					>
						Qualified/hr
					</OverviewHelpTooltip>
				</div>
				<ol className="flex flex-col gap-0.5" aria-label="All Slack qualifiers">
					{data.rows.map((row, index) => (
						<li
							key={row.slackUserId}
							className="grid grid-cols-[1.25rem_auto_minmax(0,1fr)_auto] items-center gap-2 rounded px-1.5 py-1.5 transition-colors hover:bg-muted/50"
						>
							<span className="text-center text-xs font-semibold tabular-nums text-muted-foreground/60">
								{index + 1}
							</span>
							<Avatar size="sm">
								<AvatarImage src={row.avatarUrl ?? undefined} alt="" />
								<AvatarFallback>
									{(row.displayName ?? row.slackUserId)
										.slice(0, 1)
										.toUpperCase()}
								</AvatarFallback>
							</Avatar>
							<div className="min-w-0">
								<p className="truncate text-sm font-medium">
									{row.displayName ?? row.slackUserId}
								</p>
								<p className="truncate text-xs text-muted-foreground">
									{formatWholeNumber(row.uniqueOpportunityCount)} qualified ·{" "}
									{formatWholeNumber(row.booked)} booked ·{" "}
									{`${formatDecimal(row.scheduledHours)}h scheduled (${scheduledHoursScopeLabel})`}
								</p>
							</div>
							<span className="text-sm font-semibold tabular-nums">
								{formatDecimal(row.qualifiedPerHour)}
							</span>
						</li>
					))}
				</ol>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="mb-1 flex items-center justify-between px-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
				<span>DM closer</span>
				<OverviewHelpTooltip
					label="Bookings per hour"
					description={overviewTooltips.topDmClosers.scheduledCalls}
					triggerClassName="text-[10px] font-semibold uppercase tracking-wider"
				>
					Bookings/hr
				</OverviewHelpTooltip>
			</div>
			<ol className="flex flex-col gap-0.5" aria-label="All DM closers">
				{data.rows.map((row, index) => (
					<li
						key={row.dmCloserId}
						className="grid grid-cols-[1.25rem_auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded px-1.5 py-1.5 text-sm transition-colors hover:bg-muted/50"
					>
						<span className="text-center text-xs font-semibold tabular-nums text-muted-foreground/60">
							{index + 1}
						</span>
						<MemberAvatar
							identity={{
								id: row.dmCloserId,
								name: row.displayName,
								source: "dm_closer",
							}}
							size="sm"
						/>
						<div className="min-w-0">
							<p className="truncate font-medium">{row.displayName}</p>
							<p className="truncate text-xs text-muted-foreground">
								{formatWholeNumber(row.booked)} booked ·{" "}
								{`${formatDecimal(row.scheduledHours)}h scheduled (${scheduledHoursScopeLabel})`}
							</p>
						</div>
						<span className="font-semibold tabular-nums">
							{formatDecimal(row.bookedPerHour)}
						</span>
					</li>
				))}
			</ol>
		</div>
	);
}

export function OverviewExpandableLeaderboard({
	kind,
	range,
	open,
	onOpenChange,
}: {
	kind: LeaderboardKind;
	range: DashboardRangeInput;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Collapsible open={open} onOpenChange={onOpenChange}>
			<CollapsibleTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="w-full justify-center"
				>
					{open ? (
						<ChevronUpIcon data-icon="inline-start" aria-hidden="true" />
					) : (
						<ChevronDownIcon data-icon="inline-start" aria-hidden="true" />
					)}
					{open ? "Show top 5" : "Show all"}
				</Button>
			</CollapsibleTrigger>
			<CollapsibleContent className="pt-3">
				<div className="flex flex-col gap-3">
					{open ? (
						<SectionErrorBoundary
							key={`${kind}:${JSON.stringify(range)}`}
							sectionName="expanded leaderboard"
							fallback={
								<OverviewErrorState message="This leaderboard could not be loaded." />
							}
						>
							<ExpandedLeaderboardQuery kind={kind} range={range} />
						</SectionErrorBoundary>
					) : null}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
