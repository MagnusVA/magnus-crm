"use client";

import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useEntityDetail } from "./entity-detail-context";
import { formatDate, formatMoneyMinor, formatToken } from "./entity-detail-formatters";

export function EntityHeaderSection() {
	const { lead, customer } = useEntityDetail();
	const displayName = lead.fullName ?? lead.email ?? "Unknown lead";
	const isCustomer = customer !== null;

	return (
		<section className="rounded-md border bg-card p-4">
			<div className="flex flex-col gap-3">
				<Button asChild variant="ghost" size="sm" className="w-fit px-0">
					<Link href="/workspace/leads-customers">
						<ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
						Leads & Customers
					</Link>
				</Button>
				<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight text-pretty">
								{displayName}
							</h1>
							<Badge variant={isCustomer ? "default" : "secondary"}>
								{isCustomer ? "Customer" : "Lead"}
							</Badge>
							<Badge variant="outline">
								{customer ? formatToken(customer.status) : formatToken(lead.status)}
							</Badge>
						</div>
						<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
							{lead.email ? <span className="break-all">{lead.email}</span> : null}
							{lead.phone ? <span>{lead.phone}</span> : null}
							{(lead.socialHandles ?? []).slice(0, 3).map((handle) => (
								<span key={`${handle.type}:${handle.handle}`} className="break-all">
									{handle.type} {handle.handle}
								</span>
							))}
						</div>
					</div>
				</div>

				{customer ? (
					<>
						<Separator />
						<div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
							<div className="min-w-0">
								<div className="text-muted-foreground">Converted</div>
								<div className="font-medium tabular-nums">
									{formatDate(customer.convertedAt)}
								</div>
							</div>
							<div className="min-w-0">
								<div className="text-muted-foreground">Total Paid</div>
								<div className="font-medium tabular-nums">
									{formatMoneyMinor(customer.totalPaidMinor, customer.paymentCurrency)}
								</div>
							</div>
							<div className="min-w-0">
								<div className="text-muted-foreground">Program</div>
								<div className="truncate font-medium">
									{customer.programName ?? "Not set"}
								</div>
							</div>
							<div className="min-w-0">
								<div className="text-muted-foreground">Winning Opportunity</div>
								<div className="truncate font-medium">
									{customer.winningOpportunityId ?? "Not linked"}
								</div>
							</div>
						</div>
					</>
				) : null}
			</div>
		</section>
	);
}
