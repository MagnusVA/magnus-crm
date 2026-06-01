"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { SectionErrorBoundary } from "./section-error-boundary";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { DashboardRangeInput } from "./dashboard-date-range-filter";
import { OverviewExpandedLeaderboardTable } from "./overview-expanded-leaderboard-table";
import {
	OverviewCappedState,
	OverviewEmptyState,
	OverviewErrorState,
	OverviewTruncatedNote,
} from "./overview-section-state";

type LeaderboardKind = "lead_gen" | "qualifiers" | "dm_closers";
type ScheduleFilter = "all" | "scheduled" | "unscheduled";
type ActivityFilter = "all" | "with_activity" | "without_activity";

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
	filters,
}: {
	kind: LeaderboardKind;
	range: DashboardRangeInput;
	filters:
		| {
				search?: string;
				schedule?: ScheduleFilter;
				activity?: ActivityFilter;
		  }
		| undefined;
}) {
	const data = useQuery(
		api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows,
		filters ? { kind, range, filters } : { kind, range },
	);

	if (data === undefined) {
		return <ExpandedLeaderboardSkeleton />;
	}

	if (data.cappedMessage) {
		return <OverviewCappedState message={data.cappedMessage} />;
	}

	if (data.rows.length === 0) {
		return <OverviewEmptyState message="No rows match the current filters." />;
	}

	return (
		<>
			{data.truncated ? <OverviewTruncatedNote /> : null}
			<p className="text-xs text-muted-foreground">
				Showing {data.filteredRows} of {data.totalRows}
			</p>
			<ScrollArea className="max-h-64 rounded-md border">
				<div className="min-w-0 p-1">
					<OverviewExpandedLeaderboardTable data={data} />
				</div>
			</ScrollArea>
		</>
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
	const [search, setSearch] = useState("");
	const [schedule, setSchedule] = useState<ScheduleFilter>("all");
	const [activity, setActivity] = useState<ActivityFilter>("all");
	const deferredSearch = useDeferredValue(search);

	const filters = useMemo(() => {
		const next: {
			search?: string;
			schedule?: ScheduleFilter;
			activity?: ActivityFilter;
		} = {};
		const trimmedSearch = deferredSearch.trim();
		if (trimmedSearch) next.search = trimmedSearch;
		if (schedule !== "all") next.schedule = schedule;
		if (activity !== "all") next.activity = activity;
		return Object.keys(next).length > 0 ? next : undefined;
	}, [deferredSearch, schedule, activity]);

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
					<div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
						<Input
							value={search}
							onChange={(event) => setSearch(event.currentTarget.value)}
							placeholder="Search names…"
							aria-label="Search leaderboard"
							className="h-8 sm:max-w-xs"
						/>
						<ToggleGroup
							type="single"
							variant="outline"
							size="sm"
							value={schedule}
							onValueChange={(value) => {
								if (value) setSchedule(value as ScheduleFilter);
							}}
							aria-label="Schedule filter"
						>
							<ToggleGroupItem value="all" aria-label="All schedules">
								All
							</ToggleGroupItem>
							<ToggleGroupItem value="scheduled" aria-label="Scheduled">
								Scheduled
							</ToggleGroupItem>
							<ToggleGroupItem value="unscheduled" aria-label="Unscheduled">
								Unscheduled
							</ToggleGroupItem>
						</ToggleGroup>
						<ToggleGroup
							type="single"
							variant="outline"
							size="sm"
							value={activity}
							onValueChange={(value) => {
								if (value) setActivity(value as ActivityFilter);
							}}
							aria-label="Activity filter"
						>
							<ToggleGroupItem value="all" aria-label="All activity">
								All
							</ToggleGroupItem>
							<ToggleGroupItem
								value="with_activity"
								aria-label="With activity"
							>
								Active
							</ToggleGroupItem>
							<ToggleGroupItem
								value="without_activity"
								aria-label="Without activity"
							>
								No activity
							</ToggleGroupItem>
						</ToggleGroup>
					</div>

					{open ? (
						<SectionErrorBoundary
							key={`${kind}:${JSON.stringify(range)}:${JSON.stringify(
								filters ?? {},
							)}`}
							sectionName="expanded leaderboard"
							fallback={
								<OverviewErrorState message="This leaderboard could not be loaded." />
							}
						>
							<ExpandedLeaderboardQuery
								kind={kind}
								range={range}
								filters={filters}
							/>
						</SectionErrorBoundary>
					) : null}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
