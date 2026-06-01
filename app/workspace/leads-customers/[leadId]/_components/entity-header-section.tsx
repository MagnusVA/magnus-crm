"use client";

import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	leadsCustomersTooltips,
	SimpleTooltip,
	TruncatingTooltip,
} from "../../_components/entity-ui-tooltips";
import { useEntityDetail } from "./entity-detail-context";
import {
	formatDate,
	formatMoneyMinor,
	formatToken,
} from "./entity-detail-formatters";
import { MicroLabel, Surface } from "./entity-detail-ui";

export function EntityHeaderSection() {
	const { lead, customer, opportunities } = useEntityDetail();
	const displayName = lead.fullName ?? lead.email ?? "Unknown lead";
	const isCustomer = customer !== null;

	const winning = customer
		? opportunities.find(
				({ opportunity }) => opportunity._id === customer.winningOpportunityId,
			)
		: undefined;
	const winningLabel =
		winning?.opportunity.soldProgramName ??
		winning?.opportunity.firstBookingProgramName ??
		(customer?.winningOpportunityId ? formatToken(winning?.opportunity.status) : null) ??
		"Not linked";

	const contactItems = [
		lead.email,
		lead.phone,
		...(lead.socialHandles ?? [])
			.slice(0, 3)
			.map((handle) => `${handle.type} ${handle.handle}`),
	].filter((value): value is string => Boolean(value));

	return (
		<Surface>
			<div className="flex flex-col gap-4 p-4 sm:p-5">
					<Button asChild variant="ghost" size="sm" className="-ml-2 w-fit text-muted-foreground">
						<Link href="/workspace/leads-customers">
							<ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
							Leads &amp; Customers
						</Link>
					</Button>

					<div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
						<div className="flex min-w-0 flex-col gap-2.5">
							<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
								<TruncatingTooltip content={displayName}>
									<h1
										className="min-w-0 truncate font-brand text-3xl leading-none font-light tracking-tight text-pretty"
										translate="no"
									>
										{displayName}
									</h1>
								</TruncatingTooltip>
								<div className="flex items-center gap-1.5">
									<SimpleTooltip
										content={
											isCustomer
												? leadsCustomersTooltips.lifecycle.customer
												: leadsCustomersTooltips.lifecycle.lead
										}
									>
										<Badge variant={isCustomer ? "default" : "secondary"}>
											{isCustomer ? "Customer" : "Lead"}
										</Badge>
									</SimpleTooltip>
									<SimpleTooltip
										content={`Current ${isCustomer ? "customer" : "lead"} pipeline status`}
									>
										<Badge variant="outline">
											{customer ? formatToken(customer.status) : formatToken(lead.status)}
										</Badge>
									</SimpleTooltip>
								</div>
							</div>

							{contactItems.length > 0 ? (
								<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted-foreground">
									{contactItems.map((value, index) => (
										<span key={value} className="flex min-w-0 items-center gap-2.5">
											{index > 0 ? (
												<span aria-hidden="true" className="text-border/80">
													&middot;
												</span>
											) : null}
											<TruncatingTooltip content={value}>
												<span className="min-w-0 truncate break-all" translate="no">
													{value}
												</span>
											</TruncatingTooltip>
										</span>
									))}
								</div>
							) : null}
						</div>

						{customer ? (
							<dl className="grid shrink-0 grid-cols-2 gap-px overflow-hidden rounded-lg bg-border/70 ring-1 ring-border/70 sm:grid-cols-4 lg:max-w-xl">
								<HeaderMetric
									label="Total Paid"
									tone="money"
									value={formatMoneyMinor(customer.totalPaidMinor, customer.paymentCurrency)}
								/>
								<HeaderMetric label="Converted" value={formatDate(customer.convertedAt)} />
								<HeaderMetric
									label="Program"
									value={customer.programName ?? "Not set"}
								/>
								<HeaderMetric label="Winning Deal" value={winningLabel} />
							</dl>
						) : null}
					</div>
				</div>
		</Surface>
	);
}

function HeaderMetric({
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
