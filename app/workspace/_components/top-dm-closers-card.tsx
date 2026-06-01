import { SendIcon } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import type { DashboardRangeInput } from "./dashboard-date-range-filter";
import type { TopDmClosersSection } from "./overview-dashboard-types";
import { OverviewExpandableLeaderboard } from "./overview-expandable-leaderboard";
import {
	OverviewHelpTooltip,
	overviewTooltips,
} from "./overview-help-tooltip";
import { MemberAvatar } from "./member-avatar";
import { formatDecimal, formatWholeNumber } from "./overview-formatters";
import { getScheduledHoursScopeLabel } from "./overview-scheduled-hours-label";
import {
	OverviewCappedState,
	OverviewEmptyState,
	OverviewErrorState,
} from "./overview-section-state";

export function TopDmClosersCard({
	section,
	range,
	expanded,
	onExpandedChange,
}: {
	section: TopDmClosersSection;
	range: DashboardRangeInput;
	expanded: boolean;
	onExpandedChange: (open: boolean) => void;
}) {
	const canExpand =
		section.status === "ready" || section.status === "empty";
	const scheduledHoursScopeLabel = getScheduledHoursScopeLabel(range);

	return (
		<Card className="min-w-0" size="sm">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
						<SendIcon className="h-3.5 w-3.5" aria-hidden="true" />
					</span>
					<OverviewHelpTooltip
						label="Top DM Closers"
						description={overviewTooltips.topDmClosers.section}
					>
						Top DM Closers
					</OverviewHelpTooltip>
				</CardTitle>
				<CardDescription>Ranked by bookings per scheduled hour</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{section.status === "capped" ? (
					<OverviewCappedState message={section.message} />
				) : section.status === "error" ? (
					<OverviewErrorState message={section.message} />
				) : section.status === "empty" ? (
					<OverviewEmptyState message={section.message} />
				) : (
					<>
						{!expanded ? (
							<>
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
								<ol className="flex flex-col gap-0.5" aria-label="Top DM closers">
									{section.data.rows.map((row, index) => (
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
							</>
						) : null}
						<div className="mt-1 flex items-center justify-between border-t px-1.5 pt-2.5 text-sm">
							<OverviewHelpTooltip
								label="Total booked"
								description={overviewTooltips.topDmClosers.totalScheduled}
								triggerClassName="font-medium text-muted-foreground"
							>
								Total booked
							</OverviewHelpTooltip>
							<span className="font-semibold tabular-nums">
								{formatWholeNumber(section.data.totalBooked)}
							</span>
						</div>
					</>
				)}
				{canExpand ? (
					<OverviewExpandableLeaderboard
						kind="dm_closers"
						range={range}
						open={expanded}
						onOpenChange={onExpandedChange}
					/>
				) : null}
			</CardContent>
		</Card>
	);
}
