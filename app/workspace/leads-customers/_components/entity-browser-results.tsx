"use client";

import { InboxIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	Table,
	TableBody,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useEntityBrowser } from "./entity-browser-context";
import { EntityResultMobileCard } from "./entity-result-mobile-card";
import { EntityResultRow } from "./entity-result-row";
import { ResultsLoading } from "./entity-browser-results-loading";
import {
	LabelWithInfoTooltip,
	leadsCustomersTooltips,
	SimpleTooltip,
} from "./entity-ui-tooltips";
import { useEntityResults } from "./use-entity-results";

export function EntityBrowserResults() {
	const {
		isPending,
		state: { isSearchDebouncing },
	} = useEntityBrowser();
	const {
		rows,
		isLoading,
		isRefreshing,
		filterKey,
		canLoadMore,
		isLoadingMore,
		loadMore,
		mode,
	} = useEntityResults();

	const showLoading =
		isLoading || isRefreshing || isPending || isSearchDebouncing;

	if (showLoading) {
		return <ResultsLoading key={filterKey} />;
	}

	if (rows.length === 0) {
		return (
			<Empty className="rounded-md border">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						{mode === "search" ? (
							<SearchIcon aria-hidden="true" />
						) : (
							<InboxIcon aria-hidden="true" />
						)}
					</EmptyMedia>
					<EmptyTitle>
						{mode === "search"
							? "No Leads Or Customers Found"
							: "No Leads Or Customers Yet"}
					</EmptyTitle>
					<EmptyDescription>
						{mode === "search"
							? "Try another name, contact value, or record ID."
							: "Leads and converted customers appear here after projection backfill."}
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div key={filterKey} className="flex animate-stream-in flex-col gap-3">
			<div className="hidden overflow-hidden rounded-md border md:block">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>
								<LabelWithInfoTooltip
									label="Identity"
									description={leadsCustomersTooltips.columns.identity}
								/>
							</TableHead>
							<TableHead>
								<LabelWithInfoTooltip
									label="State"
									description={leadsCustomersTooltips.columns.state}
								/>
							</TableHead>
							<TableHead>
								<LabelWithInfoTooltip
									label="Last Signal"
									description={leadsCustomersTooltips.columns.lastSignal}
								/>
							</TableHead>
							<TableHead className="text-right">
								<LabelWithInfoTooltip
									label="Related"
									description={leadsCustomersTooltips.columns.related}
									className="justify-end"
								/>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => (
							<EntityResultRow key={row._id} row={row} />
						))}
					</TableBody>
				</Table>
			</div>

			<div className="grid gap-2 md:hidden">
				{rows.map((row) => (
					<EntityResultMobileCard key={row._id} row={row} />
				))}
			</div>

			<div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
				<span className="tabular-nums">
					{rows.length} shown{mode === "search" ? " for this search" : ""}
				</span>
				{canLoadMore ? (
					<SimpleTooltip content={leadsCustomersTooltips.loadMore}>
						<Button
							variant="outline"
							size="sm"
							onClick={loadMore}
							disabled={isLoadingMore}
							className="w-fit"
						>
							{isLoadingMore ? "Loading…" : "Load More"}
						</Button>
					</SimpleTooltip>
				) : null}
			</div>
		</div>
	);
}
