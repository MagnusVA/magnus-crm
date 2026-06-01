"use client";

import { useState } from "react";
import { ChevronRightIcon, PanelRightOpenIcon } from "lucide-react";
import { OpportunitySourceBadge } from "@/app/workspace/opportunities/_components/opportunity-source-badge";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { opportunityStatusConfig } from "@/lib/status-config";
import { cn } from "@/lib/utils";
import {
	leadsCustomersTooltips,
	SimpleTooltip,
	TruncatingTooltip,
} from "../../_components/entity-ui-tooltips";
import { EntityAttributionGrid } from "./entity-attribution-grid";
import type { EntityDetailOpportunity } from "./entity-detail-context";
import { formatDate, formatMoneyMinor } from "./entity-detail-formatters";
import { MetaDot, MetaRow } from "./entity-detail-ui";
import { useOpportunitySheet } from "./opportunity-sheet-context";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";

export function EntityOpportunityRow({
	item,
	value,
}: {
	item: EntityDetailOpportunity;
	value?: { minor: number; currency: string };
}) {
	const {
		actions: { openOpportunity },
	} = useOpportunitySheet();
	const [showAttribution, setShowAttribution] = useState(false);

	const { opportunity, closer, attribution } = item;
	const program =
		opportunity.soldProgramName ??
		opportunity.firstBookingProgramName ??
		"Program not set";
	const closerLabel = closer?.fullName ?? closer?.email ?? "Unassigned";
	const accent = opportunityStatusConfig[opportunity.status]?.dotClass ?? "bg-border";
	const isWon = opportunity.status === "payment_received";
	const attributionId = `opp-attribution-${opportunity._id}`;

	return (
		<div className="relative transition-colors hover:bg-muted/30">
			<span
				aria-hidden="true"
				className={cn("absolute inset-y-0 left-0 w-[3px]", accent)}
			/>
			<div className="flex flex-col gap-2.5 py-3 pr-3 pl-4">
				<div className="flex items-start justify-between gap-3">
					<div className="flex min-w-0 flex-col gap-1.5">
						<div className="flex flex-wrap items-center gap-1.5">
							<StatusBadge status={opportunity.status} />
							<OpportunitySourceBadge source={opportunity.source ?? "calendly"} />
							{value ? (
								<SimpleTooltip content="Payments recorded against this opportunity">
									<span className="inline-flex items-center rounded-4xl bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-700 tabular-nums dark:text-emerald-400">
										{formatMoneyMinor(value.minor, value.currency)}
									</span>
								</SimpleTooltip>
							) : isWon ? (
								<span className="inline-flex items-center rounded-4xl bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
									Won
								</span>
							) : null}
						</div>
						<TruncatingTooltip content={program}>
							<div className="truncate text-sm font-medium" translate="no">
								{program}
							</div>
						</TruncatingTooltip>
						<MetaRow>
							{closer?.avatar ? (
								<MemberIdentity identity={closer.avatar} />
							) : (
								<span className="truncate" translate="no">
									Closer: {closerLabel}
								</span>
							)}
							{opportunity.latestMeetingAt ? (
								<>
									<MetaDot />
									<span className="tabular-nums">
										Latest meeting {formatDate(opportunity.latestMeetingAt)}
									</span>
								</>
							) : null}
							{opportunity.paymentReceivedAt ? (
								<>
									<MetaDot />
									<span className="tabular-nums">
										Paid {formatDate(opportunity.paymentReceivedAt)}
									</span>
								</>
							) : null}
						</MetaRow>
					</div>
					<div className="shrink-0">
						{item.permissions.canOpenOpportunity ? (
							<SimpleTooltip content={leadsCustomersTooltips.opportunityDetails}>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => openOpportunity(opportunity._id)}
								>
									<PanelRightOpenIcon data-icon="inline-start" aria-hidden="true" />
									Details
								</Button>
							</SimpleTooltip>
						) : (
							<SimpleTooltip content={leadsCustomersTooltips.summaryOnly}>
								<span className="text-[11px] text-muted-foreground">Summary only</span>
							</SimpleTooltip>
						)}
					</div>
				</div>

				{attribution ? (
					<div className="flex flex-col gap-2">
						<button
							type="button"
							onClick={() => setShowAttribution((prev) => !prev)}
							aria-expanded={showAttribution}
							aria-controls={attributionId}
							className="group/disc flex w-fit items-center gap-1 rounded-sm text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						>
							<ChevronRightIcon
								aria-hidden="true"
								className={cn(
									"size-3.5 transition-transform",
									showAttribution && "rotate-90",
								)}
							/>
							Attribution &amp; timeline
						</button>
						{showAttribution ? (
							<div id={attributionId}>
								<EntityAttributionGrid attribution={attribution} />
							</div>
						) : null}
					</div>
				) : null}
			</div>
		</div>
	);
}
