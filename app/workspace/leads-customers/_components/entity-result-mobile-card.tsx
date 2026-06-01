"use client";

import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { LeadCustomerSearchRowDto } from "@/convex/leadCustomers/types";
import {
	leadsCustomersTooltips,
	SimpleTooltip,
	TruncatingTooltip,
} from "./entity-ui-tooltips";
import {
	entityDetailHref,
	formatDate,
	lifecycleLabel,
	primaryLine,
	secondaryLine,
} from "./entity-result-formatters";

export function EntityResultMobileCard({
	row,
}: {
	row: LeadCustomerSearchRowDto;
}) {
	const primary = primaryLine(row);
	const secondary = secondaryLine(row);
	const isCustomer = row.lifecycle === "customer";

	return (
		<Link
			href={entityDetailHref(row)}
			className="rounded-md border p-3 text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<TruncatingTooltip content={primary}>
						<div className="truncate font-medium">{primary}</div>
					</TruncatingTooltip>
					<TruncatingTooltip content={secondary}>
						<div className="truncate text-muted-foreground">{secondary}</div>
					</TruncatingTooltip>
				</div>
				<SimpleTooltip
					content={
						isCustomer
							? leadsCustomersTooltips.lifecycle.customer
							: leadsCustomersTooltips.lifecycle.lead
					}
				>
					<Badge
						variant={isCustomer ? "default" : "secondary"}
						className="shrink-0"
					>
						{lifecycleLabel(row)}
					</Badge>
				</SimpleTooltip>
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
				<SimpleTooltip
					content={leadsCustomersTooltips.relatedCounts(
						row.opportunityCount,
						row.meetingCount,
					)}
				>
					<span className="tabular-nums">{row.opportunityCount} opportunities</span>
				</SimpleTooltip>
				<SimpleTooltip content="Meetings linked to this person's opportunities">
					<span className="tabular-nums">{row.meetingCount} meetings</span>
				</SimpleTooltip>
				<SimpleTooltip content="Most recent activity across linked opportunities">
					<span className="tabular-nums">{formatDate(row.latestActivityAt)}</span>
				</SimpleTooltip>
				{row.selectedOpportunityId ? (
					<SimpleTooltip content={leadsCustomersTooltips.openOpportunity}>
						<span className="inline-flex items-center gap-1 font-medium text-foreground">
							Open Opportunity
							<ExternalLinkIcon aria-hidden="true" className="size-3" />
						</span>
					</SimpleTooltip>
				) : null}
			</div>
		</Link>
	);
}
