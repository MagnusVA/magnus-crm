import { ClipboardListIcon } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import type { DashboardRangeInput } from "./dashboard-date-range-filter";
import type { LeadGenOverviewSection } from "./overview-dashboard-types";
import { OverviewExpandableLeaderboard } from "./overview-expandable-leaderboard";
import {
	OverviewHelpTooltip,
	overviewTooltips,
} from "./overview-help-tooltip";
import { MemberAvatar } from "./member-avatar";
import { formatDecimal, formatWholeNumber } from "./overview-formatters";
import {
	OverviewCappedState,
	OverviewEmptyState,
	OverviewErrorState,
} from "./overview-section-state";

export function LeadGenOverviewCard({
	section,
	range,
	expanded,
	onExpandedChange,
}: {
	section: LeadGenOverviewSection;
	range: DashboardRangeInput;
	expanded: boolean;
	onExpandedChange: (open: boolean) => void;
}) {
	const canExpand =
		section.status === "ready" || section.status === "empty";

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
						<div className="grid grid-cols-3 divide-x rounded-lg border bg-muted/30">
							<Metric
								label="Submissions"
								description={overviewTooltips.leadGen.submissions}
								value={formatWholeNumber(section.data.totalSubmissions)}
							/>
							<Metric
								label="Unique"
								description={overviewTooltips.leadGen.uniqueProspects}
								value={formatWholeNumber(section.data.uniqueProspects)}
							/>
							<Metric
								label="Leads/hr"
								description={overviewTooltips.leadGen.leadsPerHour}
								value={formatDecimal(section.data.leadsPerHour)}
							/>
						</div>
						{!expanded ? (
							<>
								<div className="flex items-center justify-between px-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
									<OverviewHelpTooltip
										label="Top lead generators"
										description={overviewTooltips.leadGen.topWorkers}
									>
										Top lead generators
									</OverviewHelpTooltip>
									<OverviewHelpTooltip
										label="Leads per hour"
										description={overviewTooltips.leadGen.workerRate}
										triggerClassName="text-[10px] font-semibold uppercase tracking-wider"
									>
										Leads/hr
									</OverviewHelpTooltip>
								</div>
								<ol
									className="flex flex-col gap-0.5"
									aria-label="Top lead generators"
								>
									{section.data.topWorkers.map((worker, index) => (
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
												<p className="truncate font-medium">
													{worker.displayName}
												</p>
												<p className="truncate text-xs text-muted-foreground">
													{formatWholeNumber(worker.submissions)} submissions ·{" "}
													{formatDecimal(worker.scheduledHours)}h scheduled
												</p>
											</div>
											<span className="font-semibold tabular-nums">
												{formatDecimal(worker.leadsPerHour)}
											</span>
										</li>
									))}
								</ol>
							</>
						) : null}
						<div className="mt-1 flex items-center justify-between border-t px-1.5 pt-2.5 text-sm">
							<OverviewHelpTooltip
								label="Duplicates"
								description={overviewTooltips.leadGen.duplicates}
								triggerClassName="font-medium text-muted-foreground"
							>
								Duplicates
							</OverviewHelpTooltip>
							<span className="font-semibold tabular-nums">
								{formatWholeNumber(section.data.duplicates)}
							</span>
						</div>
					</>
				)}
				{canExpand ? (
					<OverviewExpandableLeaderboard
						kind="lead_gen"
						range={range}
						open={expanded}
						onOpenChange={onExpandedChange}
					/>
				) : null}
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
