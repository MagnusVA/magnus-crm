"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import type { LeadCustomerSearchRowDto } from "@/convex/leadCustomers/types";
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

	return (
		<TableRow
			className="cursor-pointer"
			onClick={() => router.push(href)}
		>
			<TableCell className="max-w-[24rem]">
				<div className="min-w-0">
					<span className="block truncate font-medium">{primaryLine(row)}</span>
					<span className="block truncate text-xs text-muted-foreground">
						{secondaryLine(row)}
					</span>
				</div>
			</TableCell>
			<TableCell>
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<Badge variant={isCustomer ? "default" : "secondary"}>
						{lifecycleLabel(row)}
					</Badge>
					{row.customerStatus ? (
						<Badge variant="outline">{row.customerStatus}</Badge>
					) : (
						<Badge variant="outline">{row.leadStatus}</Badge>
					)}
				</div>
			</TableCell>
			<TableCell className="text-sm text-muted-foreground">
				<div className="flex min-w-0 flex-col gap-0.5">
					<span className="tabular-nums">{formatDate(row.latestActivityAt)}</span>
					{row.latestMeetingAt ? (
						<span className="text-xs tabular-nums">
							Meeting {formatDate(row.latestMeetingAt)}
						</span>
					) : null}
				</div>
			</TableCell>
			<TableCell className="text-right">
				{row.selectedOpportunityId ? (
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
				) : (
					<div className="flex flex-col items-end gap-0.5 text-sm">
						<span className="tabular-nums">
							{row.opportunityCount} opp / {row.meetingCount} mtg
						</span>
						{row.totalPaidMinor !== undefined ? (
							<span className="text-xs text-muted-foreground tabular-nums">
								{formatMoneyMinor(row.totalPaidMinor, row.paymentCurrency)}
							</span>
						) : null}
					</div>
				)}
			</TableCell>
		</TableRow>
	);
}
