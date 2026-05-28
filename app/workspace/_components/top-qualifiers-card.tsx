import { MessageSquareCheckIcon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import type { TopQualifiersSection } from "./overview-dashboard-types";
import {
	OverviewHelpTooltip,
	overviewTooltips,
} from "./overview-help-tooltip";
import { formatRate, formatWholeNumber } from "./overview-formatters";
import {
	OverviewCappedState,
	OverviewEmptyState,
	OverviewErrorState,
	OverviewTruncatedNote,
} from "./overview-section-state";

export function TopQualifiersCard({
	section,
}: {
	section: TopQualifiersSection;
}) {
	return (
		<Card className="min-w-0" size="sm">
			<CardHeader>
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<CardTitle className="flex items-center gap-2">
							<span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
								<MessageSquareCheckIcon className="h-3.5 w-3.5" aria-hidden="true" />
							</span>
							<OverviewHelpTooltip
								label="Top Qualifiers"
								description={overviewTooltips.topQualifiers.section}
							>
								Top Qualifiers
							</OverviewHelpTooltip>
						</CardTitle>
						<CardDescription>Slack-qualified opportunity activity</CardDescription>
					</div>
					{section.status === "ready" && section.truncated ? (
						<OverviewHelpTooltip
							label="Partial data"
							description={overviewTooltips.topQualifiers.partial}
						>
							<Badge variant="secondary">Partial</Badge>
						</OverviewHelpTooltip>
					) : null}
				</div>
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
						{section.truncated ? <OverviewTruncatedNote /> : null}
						<div className="grid grid-cols-[1.25rem_auto_minmax(0,1fr)_auto] items-center gap-2 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
							<span aria-hidden="true" />
							<span aria-hidden="true" />
							<span>Qualifier</span>
							<OverviewHelpTooltip
								label="Conversion rate"
								description={overviewTooltips.topQualifiers.conversionRate}
								triggerClassName="justify-end text-[10px] font-semibold uppercase tracking-wider"
							>
								Conversion
							</OverviewHelpTooltip>
						</div>
						<ol className="flex flex-col gap-0.5" aria-label="Top Slack qualifiers">
							{section.data.rows.map((row, index) => (
								<li
									key={row.slackUserId}
									className="grid grid-cols-[1.25rem_auto_minmax(0,1fr)_auto] items-center gap-2 rounded px-1.5 py-1.5 transition-colors hover:bg-muted/50"
								>
									<span className="text-center text-xs font-semibold tabular-nums text-muted-foreground/60">
										{index + 1}
									</span>
									<Avatar className="size-6">
										<AvatarImage src={row.avatarUrl ?? undefined} alt="" />
										<AvatarFallback className="text-[10px]">
											{(row.displayName ?? "?").slice(0, 1).toUpperCase()}
										</AvatarFallback>
									</Avatar>
									<div className="min-w-0">
										<p className="truncate text-sm font-medium">
											{row.displayName ?? row.slackUserId}
										</p>
										<p className="truncate text-xs text-muted-foreground">
											<OverviewHelpTooltip
												label="Booked"
												description={overviewTooltips.topQualifiers.booked}
												triggerClassName="text-xs text-muted-foreground"
											>
												{formatWholeNumber(row.booked)} booked
											</OverviewHelpTooltip>
											&nbsp;·&nbsp;
											<OverviewHelpTooltip
												label="Opportunities"
												description={
													overviewTooltips.topQualifiers.opportunities
												}
												triggerClassName="text-xs text-muted-foreground"
											>
												{formatWholeNumber(row.uniqueOpportunityCount)} opps
											</OverviewHelpTooltip>
										</p>
									</div>
									<span className="text-sm font-semibold tabular-nums">
										{formatRate(row.ratio)}
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
