"use client";

import {
	DashboardDateRangeFilter,
	type DashboardRangeInput,
} from "@/app/workspace/_components/dashboard-date-range-filter";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { LeadGenSource } from "./lead-gen-admin-page-client";

export function LeadGenFilterBar({
	range,
	onRangeChange,
	validationMessage,
	rangeLabel,
	source,
	onSourceChange,
}: {
	range: DashboardRangeInput;
	onRangeChange: (next: DashboardRangeInput) => void;
	validationMessage: string | null;
	rangeLabel: string;
	source: LeadGenSource | undefined;
	onSourceChange: (next: LeadGenSource | undefined) => void;
}) {
	return (
		<div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
			<div className="flex min-w-0 flex-col items-start gap-1.5">
				<Tooltip>
					<TooltipTrigger asChild>
						<ToggleGroup
							aria-label="Source filter"
							size="sm"
							type="single"
							value={source ?? "all"}
							variant="outline"
							onValueChange={(next) => {
								if (next === "instagram" || next === "meta_business") {
									onSourceChange(next);
								} else if (next === "all") {
									onSourceChange(undefined);
								}
							}}
						>
							<ToggleGroupItem aria-label="All sources" value="all">
								All Sources
							</ToggleGroupItem>
							<ToggleGroupItem aria-label="Instagram" value="instagram">
								Instagram
							</ToggleGroupItem>
							<ToggleGroupItem
								aria-label="Meta Business"
								value="meta_business"
							>
								Meta Business
							</ToggleGroupItem>
						</ToggleGroup>
					</TooltipTrigger>
					<TooltipContent className="max-w-xs text-pretty" side="bottom">
						Filter every card and table on this page to submissions from a
						single lead source.
					</TooltipContent>
				</Tooltip>
				<p className="text-xs text-muted-foreground">
					Showing: {rangeLabel}
				</p>
			</div>
			<DashboardDateRangeFilter
				validationMessage={validationMessage}
				value={range}
				onChange={onRangeChange}
			/>
		</div>
	);
}
