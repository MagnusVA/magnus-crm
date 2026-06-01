"use client";

import { useMemo } from "react";
import { TargetIcon } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import {
	LabelWithInfoTooltip,
	leadsCustomersTooltips,
} from "../../_components/entity-ui-tooltips";
import { useEntityDetail } from "./entity-detail-context";
import { EntityOpportunityRow } from "./entity-opportunity-row";
import { SectionShell } from "./entity-detail-ui";

export function EntityOpportunitiesSection() {
	const { opportunities, payments, caps } = useEntityDetail();

	const valueByOpportunity = useMemo(() => {
		const map = new Map<Id<"opportunities">, { minor: number; currency: string }>();
		for (const payment of payments) {
			if (payment.status === "disputed") continue;
			const opportunityId = payment.opportunityId ?? payment.originatingOpportunityId;
			if (!opportunityId) continue;
			const existing = map.get(opportunityId);
			map.set(opportunityId, {
				minor: (existing?.minor ?? 0) + (payment.amountMinor ?? 0),
				currency: existing?.currency ?? payment.currency,
			});
		}
		return map;
	}, [payments]);

	return (
		<SectionShell
			title="Opportunities"
			icon={<TargetIcon aria-hidden="true" />}
			count={opportunities.length || undefined}
			meta={
				caps.opportunities ? (
					<LabelWithInfoTooltip
						label="Latest 50"
						description={leadsCustomersTooltips.listCap("50 opportunities")}
					/>
				) : null
			}
			bodyClassName="divide-y divide-border/60"
		>
			{opportunities.length === 0 ? (
				<div className="p-4 text-sm text-muted-foreground">No opportunities yet.</div>
			) : (
				opportunities.map((item) => (
					<EntityOpportunityRow
						key={item.opportunity._id}
						item={item}
						value={valueByOpportunity.get(item.opportunity._id)}
					/>
				))
			)}
		</SectionShell>
	);
}
