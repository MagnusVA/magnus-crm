"use client";

import { useMemo } from "react";
import { CreditCardIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
	LabelWithInfoTooltip,
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
import { SectionShell } from "./entity-detail-ui";

export function EntityPaymentsSection() {
	const { payments, caps } = useEntityDetail();

	const total = useMemo(() => {
		const active = payments.filter((payment) => payment.status !== "disputed");
		const minor = active.reduce((sum, payment) => sum + (payment.amountMinor ?? 0), 0);
		const currency = active[0]?.currency ?? "USD";
		return { minor, currency };
	}, [payments]);

	return (
		<SectionShell
			title="Payments"
			icon={<CreditCardIcon aria-hidden="true" />}
			count={payments.length || undefined}
			meta={
				payments.length > 0 ? (
					<span className="font-semibold text-emerald-600 tabular-nums dark:text-emerald-400">
						{formatMoneyMinor(total.minor, total.currency)}
					</span>
				) : caps.payments ? (
					<LabelWithInfoTooltip
						label="Latest 50"
						description={leadsCustomersTooltips.listCap("50 payments")}
					/>
				) : null
			}
			bodyClassName="divide-y divide-border/60"
		>
			{payments.length === 0 ? (
				<div className="p-4 text-sm text-muted-foreground">
					No payments recorded.
				</div>
			) : (
				payments.map((payment) => (
					<div
						key={payment._id}
						className="flex items-start justify-between gap-3 py-3 pr-3 pl-4 transition-colors hover:bg-muted/30"
					>
						<div className="flex min-w-0 flex-col gap-1.5">
							<TruncatingTooltip content={payment.programName}>
								<div className="truncate text-sm font-medium" translate="no">
									{payment.programName}
								</div>
							</TruncatingTooltip>
							<div className="flex flex-wrap items-center gap-1.5">
								<SimpleTooltip content="Payment category (deposit, final, etc.)">
									<Badge variant="outline">{formatToken(payment.paymentType)}</Badge>
								</SimpleTooltip>
								<SimpleTooltip content="Whether this payment is active, voided, or disputed">
									<Badge variant="secondary">{formatToken(payment.status)}</Badge>
								</SimpleTooltip>
								{payment.commissionable ? (
									<SimpleTooltip content={leadsCustomersTooltips.commissionable}>
										<Badge variant="muted">Commissionable</Badge>
									</SimpleTooltip>
								) : null}
							</div>
						</div>
						<div className="flex shrink-0 flex-col items-end gap-1">
							<span className="text-sm font-semibold tabular-nums">
								{formatMoneyMinor(payment.amountMinor, payment.currency)}
							</span>
							<span className="text-[11px] text-muted-foreground tabular-nums">
								{formatDate(payment.recordedAt)}
							</span>
						</div>
					</div>
				))
			)}
		</SectionShell>
	);
}
