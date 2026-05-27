"use client";

import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon, MessageSquareIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MeetingComments } from "@/app/workspace/closer/meetings/_components/meeting-comments";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Empty,
	EmptyContent,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { usePageTitle } from "@/hooks/use-page-title";
import { BillingEventHistory } from "./billing-event-history";
import { BillingPaymentSummary } from "./billing-payment-summary";
import { BillingProofPreview } from "./billing-proof-preview";
import { BillingReviewActions } from "./billing-review-actions";
import { CopyBillingPayloadButton } from "./copy-billing-payload-button";
import { CorrectionDialog } from "./correction-dialog";

function BillingMeetingComments({
	meetingId,
}: {
	meetingId: Id<"meetings"> | null;
}) {
	if (meetingId) {
		return <MeetingComments meetingId={meetingId} />;
	}

	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex items-center gap-2">
					<MessageSquareIcon
						aria-hidden="true"
						className="size-4 text-muted-foreground"
					/>
					<CardTitle className="text-base">Comments</CardTitle>
				</div>
			</CardHeader>
			<CardContent>
				<Empty className="border-0 py-6">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<MessageSquareIcon aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>No linked meeting</EmptyTitle>
					</EmptyHeader>
					<EmptyContent>
						Comments appear here when the payment is tied to a meeting.
					</EmptyContent>
				</Empty>
			</CardContent>
		</Card>
	);
}

export function BillingReviewPageClient({
	preloadedPayment,
}: {
	preloadedPayment: Preloaded<typeof api.billing.queries.getPaymentDetail>;
}) {
	const router = useRouter();
	const detail = usePreloadedQuery(preloadedPayment);
	const titleName =
		detail?.customer.fullName ??
		detail?.customer.email ??
		detail?.payment.id ??
		"Payment";
	usePageTitle(`Billing — ${titleName}`);

	if (!detail) {
		return (
			<div className="flex max-w-xl flex-col gap-4">
				<Button asChild className="self-start" size="sm" variant="ghost">
					<Link href="/workspace/billing">
						<ArrowLeftIcon aria-hidden="true" data-icon="inline-start" />
						Billing
					</Link>
				</Button>
				<Empty className="border">
					<EmptyHeader>
						<EmptyTitle>Payment not found</EmptyTitle>
					</EmptyHeader>
					<EmptyContent>
						The payment record is missing or belongs to another tenant.
					</EmptyContent>
				</Empty>
			</div>
		);
	}

	return (
		<div className="flex min-w-0 flex-col">
			{/* Toolbar: back link on the left, actions on the right */}
			<div className="flex flex-wrap items-center justify-between gap-2 pb-2">
				<Button asChild className="-ml-3" size="sm" variant="ghost">
					<Link href="/workspace/billing">
						<ArrowLeftIcon aria-hidden="true" data-icon="inline-start" />
						Billing
					</Link>
				</Button>
				<div className="flex flex-wrap items-center gap-2">
					<CopyBillingPayloadButton detail={detail} />
					<CorrectionDialog
						payment={detail.payment}
						onCorrected={(result) => {
							toast.success(
								!result.changed
									? "No payment changes to save."
									: result.returnedToReview
										? "Payment corrected and returned to review."
										: "Payment corrected.",
							);
							router.refresh();
						}}
					/>
					<BillingReviewActions
						paymentRecordId={detail.payment.id}
						status={detail.payment.status}
					/>
				</div>
			</div>

			<BillingPaymentSummary detail={detail} />

			{/* Comments + proof preview */}
			<div className="grid items-start gap-x-6 gap-y-5 py-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:divide-x xl:divide-border">
				<div className="min-w-0 xl:pr-6">
					<BillingMeetingComments meetingId={detail.meeting.id} />
				</div>
				<div className="min-w-0 xl:pl-6">
					<BillingProofPreview proof={detail.proof} />
				</div>
			</div>

			<div className="border-t border-border pt-4">
				<BillingEventHistory events={detail.events} />
			</div>
		</div>
	);
}
