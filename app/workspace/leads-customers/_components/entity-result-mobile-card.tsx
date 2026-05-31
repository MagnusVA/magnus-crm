"use client";

import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { LeadCustomerSearchRowDto } from "@/convex/leadCustomers/types";
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
	return (
		<Link
			href={entityDetailHref(row)}
			className="rounded-md border p-3 text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="truncate font-medium">{primaryLine(row)}</div>
					<div className="truncate text-muted-foreground">
						{secondaryLine(row)}
					</div>
				</div>
				<Badge
					variant={row.lifecycle === "customer" ? "default" : "secondary"}
					className="shrink-0"
				>
					{lifecycleLabel(row)}
				</Badge>
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
				<span className="tabular-nums">{row.opportunityCount} opportunities</span>
				<span className="tabular-nums">{row.meetingCount} meetings</span>
				<span className="tabular-nums">{formatDate(row.latestActivityAt)}</span>
				{row.selectedOpportunityId ? (
					<span className="inline-flex items-center gap-1 font-medium text-foreground">
						Open Opportunity
						<ExternalLinkIcon aria-hidden="true" className="size-3" />
					</span>
				) : null}
			</div>
		</Link>
	);
}
