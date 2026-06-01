"use client";

import { useMemo } from "react";
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
import { TruncatingTooltip } from "../../_components/entity-ui-tooltips";
import {
	formatDate,
	formatMoneyMinor,
	formatToken,
} from "./entity-detail-formatters";
import { MicroLabel, Surface } from "./entity-detail-ui";

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

	const value = useMemo(() => {
		const active = detail.payments.filter((payment) => payment.status !== "disputed");
		const minor = active.reduce((sum, payment) => sum + (payment.amountMinor ?? 0), 0);
		return { minor, currency: active[0]?.currency ?? "USD" };
	}, [detail.payments]);

	const closerLabel = closer?.fullName ?? closer?.email ?? "Unassigned";

	return (
		<Surface>
			<div className="flex flex-col gap-4 p-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex flex-wrap items-center gap-1.5">
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

				<dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-border/70 ring-1 ring-border/70 sm:grid-cols-4">
					<SummaryTile
						label="Value"
						tone="money"
						value={
							value.minor > 0
								? formatMoneyMinor(value.minor, value.currency)
								: opportunity.status === "payment_received"
									? "Won"
									: "—"
						}
					/>
					<SummaryTile label="Closer" value={closerLabel} />
					<SummaryTile label="Created" value={formatDate(opportunity.createdAt)} />
					<SummaryTile
						label="Last activity"
						value={formatDate(opportunity.latestActivityAt ?? opportunity.updatedAt)}
					/>
				</dl>

				<dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
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
				</dl>

				{opportunity.notes?.trim() ? (
					<div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/30 p-3 text-sm">
						<MicroLabel>Notes</MicroLabel>
						<p className="wrap-break-word whitespace-pre-wrap" translate="no">
							{opportunity.notes}
						</p>
					</div>
				) : null}

				{opportunity.lostReason ? (
					<div className="flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
						<MicroLabel className="text-destructive">Lost reason</MicroLabel>
						<p className="wrap-break-word whitespace-pre-wrap" translate="no">
							{opportunity.lostReason}
						</p>
					</div>
				) : null}
			</div>
		</Surface>
	);
}

function SummaryTile({
	label,
	value,
	tone = "default",
}: {
	label: string;
	value: string;
	tone?: "default" | "money";
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1 bg-card px-3.5 py-2.5">
			<dt>
				<MicroLabel>{label}</MicroLabel>
			</dt>
			<TruncatingTooltip content={value}>
				<dd
					className={
						tone === "money"
							? "truncate text-base font-semibold text-emerald-600 tabular-nums dark:text-emerald-400"
							: "truncate text-sm font-semibold tabular-nums"
					}
				>
					{value}
				</dd>
			</TruncatingTooltip>
		</div>
	);
}

function DetailTerm({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<dt>
				<MicroLabel>{label}</MicroLabel>
			</dt>
			<TruncatingTooltip content={value}>
				<dd className="truncate font-medium" translate="no">
					{value}
				</dd>
			</TruncatingTooltip>
		</div>
	);
}
