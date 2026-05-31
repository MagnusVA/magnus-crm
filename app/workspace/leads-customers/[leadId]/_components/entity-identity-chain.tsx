"use client";

import { Badge } from "@/components/ui/badge";
import { useEntityDetail } from "./entity-detail-context";
import { formatToken } from "./entity-detail-formatters";

export function EntityIdentityChain() {
	const { lead, customer, opportunities } = useEntityDetail();
	const winning = opportunities.find(
		({ opportunity }) =>
			customer !== null && opportunity._id === customer.winningOpportunityId,
	);

	return (
		<section className="rounded-md border p-3">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<Badge variant="secondary">Lead</Badge>
				<span className="min-w-0 truncate font-medium">
					{lead.fullName ?? lead.email ?? lead._id}
				</span>
				{customer ? (
					<>
						<span className="text-muted-foreground">to</span>
						<Badge>Customer</Badge>
						<span className="font-medium">{formatToken(customer.status)}</span>
					</>
				) : null}
				{winning ? (
					<>
						<span className="text-muted-foreground">to</span>
						<Badge variant="outline">Winning Opportunity</Badge>
						<span className="font-medium">
							{formatToken(winning.opportunity.status)}
						</span>
					</>
				) : null}
			</div>
		</section>
	);
}
