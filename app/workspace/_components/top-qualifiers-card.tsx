import { MessageSquareCheckIcon } from "lucide-react";
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
import { MemberIdentity } from "./member-identity";

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
						<div className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
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
									className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 rounded px-1.5 py-1.5 transition-colors hover:bg-muted/50"
								>
									<span className="text-center text-xs font-semibold tabular-nums text-muted-foreground/60">
										{index + 1}
									</span>
									<div className="min-w-0">
										<MemberIdentity identity={row.qualifier} />
										<p className="truncate text-xs text-muted-foreground">
											<OverviewHelpTooltip
												label="Qualified"
												description={overviewTooltips.topQualifiers.qualified}
												triggerClassName="text-xs text-muted-foreground"
											>
												{formatWholeNumber(row.uniqueOpportunityCount)} qualified
											</OverviewHelpTooltip>
											&nbsp;·&nbsp;
											<OverviewHelpTooltip
												label="Booked"
												description={overviewTooltips.topQualifiers.booked}
												triggerClassName="text-xs text-muted-foreground"
											>
												{formatWholeNumber(row.booked)} booked
											</OverviewHelpTooltip>
										</p>
									</div>
									<span className="text-sm font-semibold tabular-nums">
										{formatRate(row.ratio)}
									</span>
								</li>
							))}
						</ol>
						<div className="mt-1 flex items-center justify-between border-t px-1.5 pt-2.5 text-sm">
							<OverviewHelpTooltip
								label="Total qualified"
								description={overviewTooltips.topQualifiers.totalQualified}
								triggerClassName="font-medium text-muted-foreground"
							>
								Total qualified
							</OverviewHelpTooltip>
							<span className="font-semibold tabular-nums">
								{formatWholeNumber(section.data.totalQualified)}
							</span>
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
