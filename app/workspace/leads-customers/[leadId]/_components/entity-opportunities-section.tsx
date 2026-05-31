"use client";

import { useEntityDetail } from "./entity-detail-context";
import { EntityOpportunityRow } from "./entity-opportunity-row";

export function EntityOpportunitiesSection() {
	const { opportunities, caps } = useEntityDetail();

	return (
		<section className="rounded-md border">
			<div className="flex items-center justify-between gap-3 border-b p-3">
				<h2 className="text-sm font-semibold">Opportunities</h2>
				{caps.opportunities ? (
					<span className="text-xs text-muted-foreground">Showing latest 50</span>
				) : null}
			</div>
			{opportunities.length === 0 ? (
				<div className="p-4 text-sm text-muted-foreground">
					No opportunities yet.
				</div>
			) : (
				<div className="divide-y">
					{opportunities.map((item) => (
						<EntityOpportunityRow key={item.opportunity._id} item={item} />
					))}
				</div>
			)}
		</section>
	);
}
