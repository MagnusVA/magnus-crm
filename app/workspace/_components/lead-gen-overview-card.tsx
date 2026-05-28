import { ClipboardListIcon } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import type { LeadGenOverviewSection } from "./overview-dashboard-types";
import {
	OverviewHelpTooltip,
	overviewTooltips,
} from "./overview-help-tooltip";
import { formatDecimal, formatWholeNumber } from "./overview-formatters";
import {
	OverviewCappedState,
	OverviewEmptyState,
	OverviewErrorState,
} from "./overview-section-state";

export function LeadGenOverviewCard({
	section,
}: {
	section: LeadGenOverviewSection;
}) {
	return (
		<Card className="min-w-0" size="sm">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
						<ClipboardListIcon className="h-3.5 w-3.5" aria-hidden="true" />
					</span>
					<OverviewHelpTooltip
						label="Lead Gen"
						description={overviewTooltips.leadGen.section}
					>
						Lead Gen
					</OverviewHelpTooltip>
				</CardTitle>
				<CardDescription>
					Submissions, throughput, and top generators
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{section.status === "capped" ? (
					<OverviewCappedState message={section.message} />
				) : section.status === "error" ? (
					<OverviewErrorState message={section.message} />
				) : section.status === "empty" ? (
					<OverviewEmptyState message={section.message} />
				) : (
					<>
						<div className="grid grid-cols-2 divide-x rounded-lg border bg-muted/30">
							<Metric
								label="Submissions"
								description={overviewTooltips.leadGen.submissions}
								value={formatWholeNumber(section.data.totalSubmissions)}
							/>
							<Metric
								label="Leads/hr"
								description={overviewTooltips.leadGen.leadsPerHour}
								value={formatDecimal(section.data.leadsPerHour)}
							/>
						</div>
						<div className="flex items-center justify-between px-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
							<OverviewHelpTooltip
								label="Top lead generators"
								description={overviewTooltips.leadGen.topWorkers}
							>
								Top lead generators
							</OverviewHelpTooltip>
							<OverviewHelpTooltip
								label="Submissions"
								description={overviewTooltips.leadGen.workerSubmissions}
								triggerClassName="text-[10px] font-semibold uppercase tracking-wider"
							>
								Submissions
							</OverviewHelpTooltip>
						</div>
						<ol className="flex flex-col gap-0.5" aria-label="Top lead generators">
							{section.data.topWorkers.map((worker, index) => (
								<li
									key={worker.workerId}
									className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded px-1.5 py-1.5 text-sm transition-colors hover:bg-muted/50"
								>
									<span className="text-center text-xs font-semibold tabular-nums text-muted-foreground/60">
										{index + 1}
									</span>
									<span className="truncate font-medium">
										{worker.displayName}
									</span>
									<span className="font-semibold tabular-nums">
										{formatWholeNumber(worker.submissions)}
									</span>
								</li>
							))}
						</ol>
					</>
				)}
			</CardContent>
		</Card>
	);
}

function Metric({
	label,
	description,
	value,
}: {
	label: string;
	description: string;
	value: string;
}) {
	return (
		<div className="min-w-0 px-3 py-2.5">
			<OverviewHelpTooltip
				label={label}
				description={description}
				triggerClassName="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
			>
				{label}
			</OverviewHelpTooltip>
			<p className="mt-0.5 text-xl font-semibold tabular-nums tracking-tight">
				{value}
			</p>
		</div>
	);
}
