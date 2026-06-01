"use client";

import {
	FingerprintIcon,
	ListTreeIcon,
	SlidersHorizontalIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
	LabelWithInfoTooltip,
	leadsCustomersTooltips,
	TruncatingTooltip,
} from "../../_components/entity-ui-tooltips";
import { useEntityDetail } from "./entity-detail-context";
import { formatToken } from "./entity-detail-formatters";
import { MicroLabel, SectionShell } from "./entity-detail-ui";

export function EntitySnapshotAside() {
	const { lead, customer, opportunities, identifiers } = useEntityDetail();
	const customFields = Object.entries(lead.customFields ?? {});
	const winning = customer
		? opportunities.find(
				({ opportunity }) => opportunity._id === customer.winningOpportunityId,
			)
		: undefined;
	const leadLabel = lead.fullName ?? lead.email ?? lead._id;

	return (
		<>
			<SectionShell
				title="Identity Path"
				icon={<ListTreeIcon aria-hidden="true" />}
				bodyClassName="p-4"
			>
				<ol className="flex flex-col gap-0">
					<ChainStep badge={<Badge variant="secondary">Lead</Badge>} value={leadLabel} />
					{customer ? (
						<ChainStep
							badge={<Badge>Customer</Badge>}
							value={formatToken(customer.status)}
							connected
						/>
					) : null}
					{winning ? (
						<ChainStep
							badge={<Badge variant="outline">Winning Deal</Badge>}
							value={formatToken(winning.opportunity.status)}
							connected
						/>
					) : null}
				</ol>
				<p className="mt-3 text-[11px] text-muted-foreground">
					<LabelWithInfoTooltip
						label="How this record converted"
						description={leadsCustomersTooltips.identityChain}
					/>
				</p>
			</SectionShell>

			<SectionShell
				title="Identifiers"
				icon={<FingerprintIcon aria-hidden="true" />}
				count={identifiers.length}
				bodyClassName="p-4"
			>
				{identifiers.length === 0 ? (
					<p className="text-sm text-muted-foreground">No identifiers recorded.</p>
				) : (
					<div className="flex flex-wrap gap-1.5">
						{identifiers.map((identifier) => {
							const label = `${formatToken(identifier.type)}: ${identifier.rawValue}`;
							return (
								<TruncatingTooltip key={identifier._id} content={label}>
									<Badge variant="outline" className="max-w-full">
										<span className="truncate" translate="no">
											{label}
										</span>
									</Badge>
								</TruncatingTooltip>
							);
						})}
					</div>
				)}
			</SectionShell>

			<SectionShell
				title="Custom Fields"
				icon={<SlidersHorizontalIcon aria-hidden="true" />}
				count={customFields.length || undefined}
				bodyClassName="p-2"
			>
				{customFields.length === 0 ? (
					<p className="p-2 text-sm text-muted-foreground">
						No custom fields recorded.
					</p>
				) : (
					<dl className="flex flex-col">
						{customFields.map(([key, value]) => (
							<div
								key={key}
								className="flex flex-col gap-0.5 rounded-md px-2 py-2 transition-colors hover:bg-muted/40"
							>
								<dt>
									<MicroLabel>{key}</MicroLabel>
								</dt>
								<dd className="text-sm font-medium wrap-break-word" translate="no">
									{value}
								</dd>
							</div>
						))}
					</dl>
				)}
			</SectionShell>
		</>
	);
}

function ChainStep({
	badge,
	value,
	connected = false,
}: {
	badge: React.ReactNode;
	value: string;
	connected?: boolean;
}) {
	return (
		<li className="relative flex items-center gap-2 py-1.5">
			{connected ? (
				<span
					aria-hidden="true"
					className="absolute -top-1.5 left-[0.4rem] h-3 w-px bg-border"
				/>
			) : null}
			{badge}
			<TruncatingTooltip content={value}>
				<span className="min-w-0 truncate text-sm font-medium" translate="no">
					{value}
				</span>
			</TruncatingTooltip>
		</li>
	);
}
