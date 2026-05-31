"use client";

import type { FunctionReturnType } from "convex/server";
import { BellRingIcon, MessageSquareTextIcon } from "lucide-react";
import { OpportunitySourceBadge } from "@/app/workspace/opportunities/_components/opportunity-source-badge";
import { DeleteOpportunityDialog } from "@/app/workspace/opportunities/[opportunityId]/_components/delete-opportunity-dialog";
import { MarkSideDealLostDialog } from "@/app/workspace/opportunities/[opportunityId]/_components/mark-side-deal-lost-dialog";
import { SideDealPaymentDialog } from "@/app/workspace/opportunities/[opportunityId]/_components/side-deal-payment-dialog";
import { VoidPaymentDialog } from "@/app/workspace/opportunities/[opportunityId]/_components/void-payment-dialog";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { api } from "@/convex/_generated/api";
import { formatDate, formatToken } from "./entity-detail-formatters";

type OpportunityDetail = NonNullable<
	FunctionReturnType<typeof api.opportunities.detailQuery.getOpportunityDetail>
>;

export function OpportunitySheetSummary({
	detail,
}: {
	detail: OpportunityDetail;
}) {
	const { opportunity, closer, pendingStaleNudge, permissions, attribution } =
		detail;

	return (
		<section className="flex flex-col gap-3 rounded-md border p-3">
			<div className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<OpportunitySourceBadge source={opportunity.source} />
					<StatusBadge status={opportunity.status} />
					{detail.lead?.status ? (
						<Badge variant="muted">Lead {formatToken(detail.lead.status)}</Badge>
					) : null}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{permissions.canRecordPayment ? (
						<SideDealPaymentDialog opportunityId={opportunity._id} />
					) : null}
					{permissions.canMarkLost ? (
						<MarkSideDealLostDialog opportunityId={opportunity._id} />
					) : null}
					{permissions.canVoidPayment && permissions.voidablePaymentId ? (
						<VoidPaymentDialog paymentId={permissions.voidablePaymentId} />
					) : null}
					{permissions.canDeleteOpportunity ? (
						<DeleteOpportunityDialog opportunityId={opportunity._id} />
					) : null}
				</div>
			</div>

			{pendingStaleNudge ? (
				<Alert>
					<BellRingIcon aria-hidden="true" />
					<AlertDescription>
						This side-deal opportunity has had no recent activity.
					</AlertDescription>
				</Alert>
			) : null}

			{attribution?.slackQualification ? (
				<Alert>
					<MessageSquareTextIcon aria-hidden="true" />
					<AlertDescription>
						Qualified via Slack by{" "}
						<span className="font-medium">
							{attribution.slackQualification.slackUserLabel}
						</span>
						.
					</AlertDescription>
				</Alert>
			) : null}

			<dl className="grid gap-3 text-sm sm:grid-cols-2">
				<DetailTerm
					label="Closer"
					value={closer?.fullName ?? closer?.email ?? "Unassigned"}
				/>
				<DetailTerm
					label="Booked program"
					value={opportunity.firstBookingProgramName ?? "Not mapped"}
				/>
				<DetailTerm
					label="Sold program"
					value={opportunity.soldProgramName ?? "Not sold"}
				/>
				<DetailTerm
					label="Payment received"
					value={formatDate(opportunity.paymentReceivedAt)}
				/>
				<DetailTerm label="Created" value={formatDate(opportunity.createdAt)} />
				<DetailTerm
					label="Last activity"
					value={formatDate(opportunity.latestActivityAt ?? opportunity.updatedAt)}
				/>
			</dl>

			{opportunity.notes?.trim() ? (
				<div className="flex flex-col gap-1 text-sm">
					<p className="text-xs font-medium text-muted-foreground">Notes</p>
					<p className="whitespace-pre-wrap break-words">{opportunity.notes}</p>
				</div>
			) : null}

			{opportunity.lostReason ? (
				<div className="flex flex-col gap-1 text-sm">
					<p className="text-xs font-medium text-muted-foreground">
						Lost reason
					</p>
					<p className="whitespace-pre-wrap break-words">
						{opportunity.lostReason}
					</p>
				</div>
			) : null}
		</section>
	);
}

function DetailTerm({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0">
			<dt className="text-xs font-medium text-muted-foreground">{label}</dt>
			<dd className="truncate font-medium" title={value}>
				{value}
			</dd>
		</div>
	);
}
