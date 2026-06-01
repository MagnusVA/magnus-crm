"use client";

import Link from "next/link";
import { PlusIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useEntityBrowser, type EntityLifecycleFilter } from "./entity-browser-context";
import {
	leadsCustomersTooltips,
	SimpleTooltip,
} from "./entity-ui-tooltips";
import { useEntityResults } from "./use-entity-results";

const lifecycleItems: Array<{
	value: EntityLifecycleFilter;
	label: string;
	tooltip: string;
}> = [
	{ value: "all", label: "All", tooltip: leadsCustomersTooltips.lifecycle.all },
	{ value: "lead", label: "Leads", tooltip: leadsCustomersTooltips.lifecycle.lead },
	{
		value: "customer",
		label: "Customers",
		tooltip: leadsCustomersTooltips.lifecycle.customer,
	},
];

export function EntityBrowserToolbar() {
	const { state, actions, isPending } = useEntityBrowser();
	const { isSearchDebouncing } = state;
	const { isLoading, isRefreshing } = useEntityResults();
	const isResultsLoading =
		isLoading || isRefreshing || isPending || isSearchDebouncing;

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
				<div className="min-w-0">
					<h1 className="text-2xl font-semibold tracking-tight text-pretty">
						Leads & Customers
					</h1>
					<p className="max-w-2xl text-sm text-muted-foreground">
						Find people by name, email, phone, handle, or known record ID.
					</p>
				</div>
				<SimpleTooltip content={leadsCustomersTooltips.newSideDeal} side="left">
					<Button asChild size="sm" className="shrink-0">
						<Link href="/workspace/leads-customers/new-opportunity">
							<PlusIcon data-icon="inline-start" aria-hidden="true" />
							New Side Deal
						</Link>
					</Button>
				</SimpleTooltip>
			</div>

			<div className="rounded-md border bg-card p-3">
				<div className="flex flex-col gap-3 lg:flex-row lg:items-center">
					<label className="relative block min-w-0 flex-1">
						<span className="sr-only">Search Leads & Customers</span>
						<SimpleTooltip
							content={leadsCustomersTooltips.search}
							side="bottom"
						>
							<span className="pointer-events-auto absolute left-3 top-1/2 z-10 -translate-y-1/2">
								<SearchIcon
									aria-hidden="true"
									className="size-4 text-muted-foreground"
								/>
							</span>
						</SimpleTooltip>
						<Input
							name="entity-search"
							value={state.query}
							onChange={(event) => actions.setQuery(event.target.value)}
							className="h-9 pl-9"
							placeholder="Search identifier…"
							autoComplete="off"
							spellCheck={false}
							aria-describedby="entity-search-status"
						/>
					</label>
					<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between lg:justify-start">
						<ToggleGroup
							type="single"
							value={state.lifecycle}
							onValueChange={(value) => {
								if (value) actions.setLifecycle(value as EntityLifecycleFilter);
							}}
							aria-label="Filter lifecycle"
							variant="outline"
							size="sm"
						>
							{lifecycleItems.map((item) => (
								<SimpleTooltip key={item.value} content={item.tooltip}>
									<ToggleGroupItem value={item.value}>
										{item.label}
									</ToggleGroupItem>
								</SimpleTooltip>
							))}
						</ToggleGroup>
						<span
							id="entity-search-status"
							aria-live="polite"
							className="min-h-4 text-xs text-muted-foreground"
						>
							{isResultsLoading ? "Loading results…" : null}
						</span>
					</div>
				</div>
			</div>
		</div>
	);
}
