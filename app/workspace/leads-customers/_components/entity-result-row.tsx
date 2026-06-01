"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import type { LeadCustomerSearchRowDto } from "@/convex/leadCustomers/types";
import {
	leadsCustomersTooltips,
	SimpleTooltip,
	TruncatingTooltip,
} from "./entity-ui-tooltips";
import {
	entityDetailHref,
	formatDate,
	formatMoneyMinor,
	lifecycleLabel,
	primaryLine,
	secondaryLine,
} from "./entity-result-formatters";

export function EntityResultRow({ row }: { row: LeadCustomerSearchRowDto }) {
	const router = useRouter();
	const href = entityDetailHref(row);
	const isCustomer = row.lifecycle === "customer";
	const primary = primaryLine(row);
	const secondary = secondaryLine(row);
	const statusLabel = row.customerStatus ?? row.leadStatus;

	return (
		<TableRow
			className="cursor-pointer"
			onClick={() => router.push(href)}
		>
			<TableCell className="max-w-[24rem]">
				<div className="min-w-0">
					<TruncatingTooltip content={primary}>
						<span className="block truncate font-medium">{primary}</span>
					</TruncatingTooltip>
					<TruncatingTooltip content={secondary}>
						<span className="block truncate text-xs text-muted-foreground">
							{secondary}
						</span>
					</TruncatingTooltip>
				</div>
			</TableCell>
			<TableCell>
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<SimpleTooltip
						content={
							isCustomer
								? leadsCustomersTooltips.lifecycle.customer
								: leadsCustomersTooltips.lifecycle.lead
						}
					>
						<Badge variant={isCustomer ? "default" : "secondary"}>
							{lifecycleLabel(row)}
						</Badge>
					</SimpleTooltip>
					{statusLabel ? (
						<SimpleTooltip content={`Pipeline status: ${statusLabel}`}>
							<Badge variant="outline">{statusLabel}</Badge>
						</SimpleTooltip>
					) : null}
				</div>
			</TableCell>
			<TableCell className="text-sm text-muted-foreground">
				<div className="flex min-w-0 flex-col gap-0.5">
					<SimpleTooltip content="Most recent activity across linked opportunities">
						<span className="tabular-nums">{formatDate(row.latestActivityAt)}</span>
					</SimpleTooltip>
					{row.latestMeetingAt ? (
						<SimpleTooltip content="Most recent scheduled or completed meeting">
							<span className="text-xs tabular-nums">
								Meeting {formatDate(row.latestMeetingAt)}
							</span>
						</SimpleTooltip>
					) : null}
				</div>
			</TableCell>
			<TableCell className="text-right">
				{row.selectedOpportunityId ? (
					<SimpleTooltip content={leadsCustomersTooltips.openOpportunity}>
						<Button
							asChild
							variant="ghost"
							size="sm"
							onClick={(event) => event.stopPropagation()}
						>
							<Link href={href}>
								Open Opportunity
								<ExternalLinkIcon data-icon="inline-end" aria-hidden="true" />
							</Link>
						</Button>
					</SimpleTooltip>
				) : (
					<div className="flex flex-col items-end gap-0.5 text-sm">
						<SimpleTooltip
							content={leadsCustomersTooltips.relatedCounts(
								row.opportunityCount,
								row.meetingCount,
							)}
						>
							<span className="tabular-nums">
								{row.opportunityCount} opp / {row.meetingCount} mtg
							</span>
						</SimpleTooltip>
						{row.totalPaidMinor !== undefined ? (
							<SimpleTooltip content={leadsCustomersTooltips.totalPaid}>
								<span className="text-xs text-muted-foreground tabular-nums">
									{formatMoneyMinor(row.totalPaidMinor, row.paymentCurrency)}
								</span>
							</SimpleTooltip>
						) : null}
					</div>
				)}
			</TableCell>
		</TableRow>
	);
}
