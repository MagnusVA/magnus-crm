"use client";

import type { FunctionReturnType } from "convex/server";
import {
	ArrowUpRightIcon,
	FileTextIcon,
	PaperclipIcon,
	VideoIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import { Button } from "@/components/ui/button";
import { formatAmountMinor } from "@/lib/format-currency";
import { cn } from "@/lib/utils";

type BillingPaymentDetail = NonNullable<
	FunctionReturnType<typeof api.billing.queries.getPaymentDetail>
>;
type PaymentStatus = BillingPaymentDetail["payment"]["status"];

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

const PAYMENT_TYPE_LABELS: Record<
	BillingPaymentDetail["payment"]["paymentType"],
	string
> = {
	monthly: "Monthly",
	split: "Split",
	pif: "Paid in full",
	deposit: "Deposit",
};

const ORIGIN_LABELS: Record<string, string> = {
	closer_meeting: "Closer meeting",
	closer_reminder: "Closer reminder",
	admin_meeting: "Admin meeting",
	admin_reminder: "Admin reminder",
	admin_review_resolution: "Admin review",
	closer_side_deal: "Closer side deal",
	admin_side_deal: "Admin side deal",
	closer_additional: "Additional (closer)",
	admin_additional: "Additional (admin)",
	customer_direct: "Customer direct",
	bookkeeper_direct: "Bookkeeper direct",
};

function formatOrigin(origin: string) {
	return ORIGIN_LABELS[origin] ?? origin.replaceAll("_", " ");
}

const STATUS_TONE: Record<
	PaymentStatus,
	{ label: string; dot: string; text: string; ring: string }
> = {
	recorded: {
		label: "Needs review",
		dot: "bg-amber-500",
		text: "text-amber-700 dark:text-amber-400",
		ring: "ring-amber-500/25",
	},
	verified: {
		label: "Reviewed",
		dot: "bg-emerald-500",
		text: "text-emerald-700 dark:text-emerald-400",
		ring: "ring-emerald-500/25",
	},
	disputed: {
		label: "Disputed",
		dot: "bg-rose-500",
		text: "text-rose-700 dark:text-rose-400",
		ring: "ring-rose-500/25",
	},
};

function formatBytes(size: number | null) {
	if (size === null) return null;
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(value: number | null) {
	return value ? dateTimeFormatter.format(new Date(value)) : null;
}

function StatusIndicator({ status }: { status: PaymentStatus }) {
	const tone = STATUS_TONE[status];
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.14em]",
				tone.text,
			)}
		>
			<span
				aria-hidden="true"
				className={cn("size-1.5 rounded-full ring-2", tone.dot, tone.ring)}
			/>
			{tone.label}
		</span>
	);
}

function SectionLabel({ children }: { children: ReactNode }) {
	return (
		<h2 className="text-[0.6rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
			{children}
		</h2>
	);
}

function Field({
	label,
	value,
	mono = false,
	className,
}: {
	label: string;
	value: ReactNode;
	mono?: boolean;
	className?: string;
}) {
	const isEmpty =
		value === null || value === undefined || value === "" || value === false;
	return (
		<>
			<dt className="border-b border-dashed border-border/35 py-1 pr-3 text-xs text-muted-foreground">
				{label}
			</dt>
			<dd
				className={cn(
					"min-w-0 border-b border-dashed border-border/35 py-1 text-xs text-foreground",
					mono && "font-mono text-[0.72rem]",
					className,
				)}
			>
				{isEmpty ? (
					<span aria-label="Empty" className="text-muted-foreground/50">
						—
					</span>
				) : (
					value
				)}
			</dd>
		</>
	);
}

function DetailBlock({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<div className="min-w-0">
			<SectionLabel>{title}</SectionLabel>
			<dl className="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-4">
				{children}
			</dl>
		</div>
	);
}

export function BillingPaymentSummary({
	detail,
}: {
	detail: BillingPaymentDetail;
}) {
	const customerName =
		detail.customer.fullName ?? detail.customer.email ?? "Missing customer";
	const proofSize = formatBytes(detail.proof.size);
	const amount = formatAmountMinor(
		detail.payment.amountMinor,
		detail.payment.currency,
	);
	const paidAt = formatDateTime(detail.payment.recordedAt);
	const meetingAt = formatDateTime(detail.meeting.scheduledAt);
	const reviewedAt = formatDateTime(detail.review.reviewedAt);
	// Prefer the payment's own Fathom link (e.g. additional payments on a won
	// opportunity, which may have no associated meeting); fall back to the
	// meeting's link for payments logged from a meeting outcome.
	const fathomLink =
		typeof detail.payment.fathomLink === "string" &&
		detail.payment.fathomLink.trim().length > 0
			? detail.payment.fathomLink
			: typeof detail.meeting.fathomLink === "string" &&
					detail.meeting.fathomLink.trim().length > 0
				? detail.meeting.fathomLink
				: null;
	const proofContentTypeLabel = detail.proof.contentType ?? "file";

	return (
		<article className="min-w-0 divide-y divide-border border-y border-border">
			{/* Hero */}
			<section className="py-4">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<StatusIndicator status={detail.payment.status} />
					<span className="font-mono text-[0.68rem] text-muted-foreground/75">
						{detail.payment.id}
					</span>
				</div>

				<p className="mt-2 wrap-break-word font-brand text-4xl font-light leading-none tracking-[-0.02em] tabular-nums text-foreground sm:text-5xl">
					{amount}
				</p>

				<p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-sm">
					<span className="font-medium text-foreground">{customerName}</span>
					<span aria-hidden="true" className="text-muted-foreground/40">
						/
					</span>
					<span className="text-muted-foreground">
						{detail.payment.programName}
					</span>
				</p>

				{/* Inline quick facts */}
				<dl className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
					<div className="flex items-baseline gap-1.5">
						<dt className="text-muted-foreground">Type</dt>
						<dd className="font-medium">
							{PAYMENT_TYPE_LABELS[detail.payment.paymentType]}
						</dd>
					</div>
					<div className="flex items-baseline gap-1.5">
						<dt className="text-muted-foreground">Paid</dt>
						<dd className="font-medium tabular-nums">{paidAt ?? "—"}</dd>
					</div>
					<div className="flex items-baseline gap-1.5">
						<dt className="text-muted-foreground">Commission</dt>
						<dd className="font-medium">
							{detail.payment.commissionable ? "Eligible" : "Not eligible"}
						</dd>
					</div>
					<div className="flex items-baseline gap-1.5">
						<dt className="text-muted-foreground">Ref</dt>
						<dd className="font-mono text-[0.72rem]">
							{detail.payment.referenceCode ?? "—"}
						</dd>
					</div>
				</dl>

				{/* Links + proof in one row */}
				<div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">
					{fathomLink ? (
						<Button
							asChild
							className="group h-7 -ml-2 gap-1.5 px-2 text-xs"
							size="sm"
							variant="ghost"
						>
							<a href={fathomLink} rel="noreferrer" target="_blank">
								<VideoIcon aria-hidden="true" className="size-3.5" />
								Fathom
								<ArrowUpRightIcon
									aria-hidden="true"
									className="size-3 text-muted-foreground"
								/>
							</a>
						</Button>
					) : null}
					{detail.proof.url ? (
						<Button
							asChild
							className="group h-7 gap-1.5 px-2 text-xs"
							size="sm"
							variant="ghost"
						>
							<a href={detail.proof.url} rel="noreferrer" target="_blank">
								<PaperclipIcon aria-hidden="true" className="size-3.5" />
								Proof
								<span className="font-normal text-muted-foreground">
									{proofContentTypeLabel}
									{proofSize ? ` · ${proofSize}` : null}
								</span>
								<ArrowUpRightIcon
									aria-hidden="true"
									className="size-3 text-muted-foreground"
								/>
							</a>
						</Button>
					) : (
						<span className="inline-flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
							<FileTextIcon aria-hidden="true" className="size-3.5" />
							No proof attached
						</span>
					)}
				</div>
			</section>

			{/* All detail blocks in one grid */}
			<section className="grid gap-x-6 gap-y-4 py-3 sm:grid-cols-2 xl:grid-cols-4">
				<DetailBlock title="Client">
					<Field label="Name" value={detail.customer.fullName ?? null} />
					<Field
						label="Email"
						value={
							detail.customer.email ? (
								<a
									className="underline decoration-muted-foreground/30 decoration-1 underline-offset-2 hover:decoration-foreground"
									href={`mailto:${detail.customer.email}`}
								>
									{detail.customer.email}
								</a>
							) : null
						}
					/>
					<Field label="Phone" value={detail.customer.phone ?? null} mono />
				</DetailBlock>

				<DetailBlock title="Meeting">
					<Field label="Scheduled" value={meetingAt} />
					<Field
						label="Fathom"
						value={
							fathomLink ? (
								<a
									className="inline-flex items-center gap-0.5 underline decoration-muted-foreground/30 decoration-1 underline-offset-2 hover:decoration-foreground"
									href={fathomLink}
									rel="noreferrer"
									target="_blank"
								>
									Open
									<ArrowUpRightIcon aria-hidden="true" className="size-2.5" />
								</a>
							) : null
						}
					/>
				</DetailBlock>

				<DetailBlock title="Attribution">
					<Field
						label="Entered by"
						value={<MemberIdentity identity={detail.enteredBy.identity} />}
					/>
					<Field
						label="Phone closer"
						value={
							detail.phoneCloser.identity ? (
								<MemberIdentity identity={detail.phoneCloser.identity} />
							) : (
								detail.phoneCloser.name
							)
						}
					/>
					<Field label="DM team" value={detail.dmAttribution.teamName} />
					<Field
						label="DM closer"
						value={
							detail.dmAttribution.dmCloser ? (
								<MemberIdentity identity={detail.dmAttribution.dmCloser} />
							) : (
								detail.dmAttribution.dmCloserName
							)
						}
					/>
					<Field
						label="Slack"
						value={
							detail.slackContributorSummary.count > 0
								? `${detail.slackContributorSummary.latestLabel} (${detail.slackContributorSummary.count})`
								: null
						}
					/>
				</DetailBlock>

				<DetailBlock title="Review">
					<Field label="Program" value={detail.payment.programName} />
					<Field label="Origin" value={formatOrigin(detail.payment.origin)} />
					<Field
						label="Reviewer"
						value={
							detail.review.reviewer ? (
								<MemberIdentity identity={detail.review.reviewer} />
							) : (
								detail.review.reviewerName
							)
						}
					/>
					<Field label="Reviewed at" value={reviewedAt} />
					<Field
						label="Note"
						value={detail.payment.note}
						className="whitespace-pre-wrap wrap-break-word"
					/>
				</DetailBlock>
			</section>
		</article>
	);
}
