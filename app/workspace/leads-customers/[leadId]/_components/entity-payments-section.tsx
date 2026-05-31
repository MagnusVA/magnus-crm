"use client";

import { Badge } from "@/components/ui/badge";
import { useEntityDetail } from "./entity-detail-context";
import { formatDate, formatMoneyMinor, formatToken } from "./entity-detail-formatters";

export function EntityPaymentsSection() {
	const { payments, caps } = useEntityDetail();

	return (
		<section className="rounded-md border">
			<div className="flex items-center justify-between gap-3 border-b p-3">
				<h2 className="text-sm font-semibold">Payments</h2>
				{caps.payments ? (
					<span className="text-xs text-muted-foreground">Showing latest 50</span>
				) : null}
			</div>
			{payments.length === 0 ? (
				<div className="p-4 text-sm text-muted-foreground">
					No payments recorded.
				</div>
			) : (
				<div className="divide-y">
					{payments.map((payment) => (
						<div
							key={payment._id}
							className="grid gap-2 p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto]"
						>
							<div className="min-w-0">
								<div className="truncate font-medium">{payment.programName}</div>
								<div className="mt-1 flex flex-wrap gap-2">
									<Badge variant="outline">{formatToken(payment.paymentType)}</Badge>
									<Badge variant="secondary">{formatToken(payment.status)}</Badge>
									{payment.commissionable ? (
										<Badge variant="muted">Commissionable</Badge>
									) : null}
								</div>
							</div>
							<div className="tabular-nums">
								{formatMoneyMinor(payment.amountMinor, payment.currency)}
							</div>
							<div className="text-muted-foreground tabular-nums">
								{formatDate(payment.recordedAt)}
							</div>
						</div>
					))}
				</div>
			)}
		</section>
	);
}
