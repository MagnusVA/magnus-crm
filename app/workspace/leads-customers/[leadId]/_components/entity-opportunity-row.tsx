"use client";

import { PanelRightOpenIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { EntityDetailOpportunity } from "./entity-detail-context";
import { EntityAttributionGrid } from "./entity-attribution-grid";
import { formatDate, formatToken } from "./entity-detail-formatters";
import { useOpportunitySheet } from "./opportunity-sheet-context";

export function EntityOpportunityRow({
	item,
}: {
	item: EntityDetailOpportunity;
}) {
	const {
		actions: { openOpportunity },
	} = useOpportunitySheet();
	const program =
		item.opportunity.soldProgramName ??
		item.opportunity.firstBookingProgramName ??
		"Program not set";

	return (
		<div className="grid gap-3 p-3 text-sm lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-start">
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant="secondary">{formatToken(item.opportunity.status)}</Badge>
					<Badge variant="outline">{formatToken(item.opportunity.source)}</Badge>
				</div>
				<div className="mt-1 truncate font-medium">{program}</div>
				<div className="mt-1 text-xs text-muted-foreground">
					Closer: {item.closer?.fullName ?? item.closer?.email ?? "Unassigned"}
				</div>
			</div>
			<div className="min-w-0 text-muted-foreground">
				<div className="truncate">
					Booked: {item.opportunity.firstBookingProgramName ?? "Not mapped"}
				</div>
				<div className="truncate">
					Latest meeting: {formatDate(item.opportunity.latestMeetingAt)}
				</div>
			</div>
			<div className="min-w-0 text-muted-foreground">
				<div className="truncate">
					Sold: {item.opportunity.soldProgramName ?? "Not sold"}
				</div>
				<div className="truncate">
					Payment: {formatDate(item.opportunity.paymentReceivedAt)}
				</div>
			</div>
			<div className="flex items-start lg:justify-end">
				{item.permissions.canOpenOpportunity ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => openOpportunity(item.opportunity._id)}
					>
						<PanelRightOpenIcon data-icon="inline-start" aria-hidden="true" />
						Details
					</Button>
				) : (
					<span className="text-xs text-muted-foreground">Summary only</span>
				)}
			</div>
			{item.attribution ? (
				<div className="lg:col-span-4">
					<EntityAttributionGrid attribution={item.attribution} />
				</div>
			) : null}
		</div>
	);
}
