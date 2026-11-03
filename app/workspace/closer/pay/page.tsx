import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { PayPageClient } from "./_components/pay-page-client";
import { PayPageSkeleton } from "./_components/pay-page-skeleton";

export const unstable_instant = false;

/**
 * The payment link's receipt page (docs/plans/closer-assistant.md decision
 * 27): `/workspace/closer/pay?meetingId=…` or `?followUpId=…`, with the
 * values an agent filled in. Built by `buildPaymentLink` in
 * lib/paymentLink.ts.
 */
export default async function CloserPayPage() {
	await requireRole(["closer"]);
	return (
		<Suspense fallback={<PayPageSkeleton />}>
			<PayPageClient />
		</Suspense>
	);
}
