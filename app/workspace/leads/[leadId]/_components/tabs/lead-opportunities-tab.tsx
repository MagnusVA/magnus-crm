"use client";

import Link from "next/link";
import { OpportunitySourceBadge } from "@/app/workspace/opportunities/_components/opportunity-source-badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
	opportunityStatusConfig,
	type OpportunityStatus,
} from "@/lib/status-config";
import type { Doc } from "@/convex/_generated/dataModel";

type LeadDetailOpportunity = Doc<"opportunities"> & {
	closerName: string | null;
	eventTypeName: string | null;
};

interface LeadOpportunitiesTabProps {
	opportunities: LeadDetailOpportunity[];
}

export function LeadOpportunitiesTab({
	opportunities,
}: LeadOpportunitiesTabProps) {
	if (opportunities.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-12">
				<p className="text-sm text-muted-foreground">
					No opportunities linked to this lead.
				</p>
			</div>
		);
	}

	return (
		<div className="rounded-lg border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Opportunity</TableHead>
						<TableHead>Closer</TableHead>
						<TableHead>Event Type</TableHead>
						<TableHead>Created</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{opportunities.map((opp) => {
						const statusCfg =
							opportunityStatusConfig[opp.status as OpportunityStatus];

						return (
							<TableRow key={opp._id}>
								<TableCell>
									<div className="flex min-w-0 flex-col gap-2">
										<Link
											href={`/workspace/opportunities/${opp._id}`}
											className="text-sm font-medium hover:underline"
										>
											{statusCfg?.label ?? opp.status.replace(/_/g, " ")}
										</Link>
										<div className="flex flex-wrap gap-2">
											<OpportunitySourceBadge source={opp.source ?? "calendly"} />
											{statusCfg ? (
												<Badge
													variant="secondary"
													className={cn("text-xs", statusCfg.badgeClass)}
												>
													{statusCfg.label}
												</Badge>
											) : (
												<Badge variant="outline" className="text-xs">
													{opp.status}
												</Badge>
											)}
											{opp.firstBookingProgramName ? (
												<Badge variant="outline" className="text-xs">
													Booked: {opp.firstBookingProgramName}
												</Badge>
											) : null}
											{opp.soldProgramName ? (
												<Badge variant="secondary" className="text-xs">
													Sold: {opp.soldProgramName}
												</Badge>
											) : null}
										</div>
									</div>
								</TableCell>
								<TableCell>
									{opp.closerName ?? (
										<span className="text-muted-foreground">Unassigned</span>
									)}
								</TableCell>
								<TableCell>
									{opp.eventTypeName ?? (
										<span className="text-muted-foreground">--</span>
									)}
								</TableCell>
								<TableCell className="text-muted-foreground">
									<time
										dateTime={new Date(opp._creationTime).toISOString()}
									>
										{new Date(opp._creationTime).toLocaleDateString(
											"en-US",
											{
												month: "short",
												day: "numeric",
												year: "numeric",
											},
										)}
									</time>
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</div>
	);
}
