"use client";

import { Component, type ReactNode, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import posthog from "posthog-js";
import { toast } from "sonner";
import { AlertCircleIcon, CheckCircle2Icon, PencilIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
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
import { Spinner } from "@/components/ui/spinner";
import { TranslatableText } from "@/components/translatable-text";
import { usePageTitle } from "@/hooks/use-page-title";
import { isAwaitingOutcome, isReminderDealFinished } from "@/lib/deal-controls";
import { getErrorMessage } from "@/lib/errors";
import { formatAmountMinor } from "@/lib/format-currency";
import { reportClientError } from "@/lib/observability/report-client-error";
import {
	buildPaymentDialogLink,
	readPaymentLink,
	type PaymentLinkInput,
} from "@/lib/paymentLink";
import { PROOF_REQUIRED_MESSAGE } from "@/lib/paymentProof";
import {
	proofNeedFor,
	useWhopPaymentCheck,
	useWhopStepState,
	whopSuccessMessage,
	type WhopAnswer,
} from "@/app/workspace/_components/payments/whop-payment-check";
import {
	WhopCapacityHold,
	WhopPaymentFoundStep,
} from "@/app/workspace/_components/payments/whop-payment-found-step";
import { PayPageSkeleton } from "./pay-page-skeleton";
import { ProofDropZone, proofFileProblem } from "./proof-drop-zone";

const PAYMENT_TYPE_LABELS = {
	monthly: "Monthly",
	split: "Split",
	pif: "Paid in full",
	deposit: "Deposit",
} as const;

/**
 * The receipt page. The values come from the link and show read-only; the
 * closer adds the receipt and logs the payment with the same mutation the
 * dialog uses, under the same proof rule. "Edit in full" opens the dialog
 * with the same values on the meeting or task page.
 */
export function PayPageClient() {
	usePageTitle("Log payment");
	const searchParams = useSearchParams();
	const link = useMemo(() => readPaymentLink(searchParams), [searchParams]);

	if (!link) {
		return (
			<PayNotice title="This payment link is incomplete">
				It names no call or task. Open the payment from the call or the task
				instead.
			</PayNotice>
		);
	}

	return (
		<PayLinkErrorBoundary>
			<PayTarget link={link} />
		</PayLinkErrorBoundary>
	);
}

/**
 * Tells a sign-in that hasn't settled apart from a link the closer can't use.
 * The queries wait for the session's token, but one that expires mid-visit
 * still throws an auth error; that is worth a retry, not "this link isn't
 * yours". Try again remounts the page, so it reads with the fresh token.
 */
class PayLinkErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
	state: { error: unknown } = { error: null };

	static getDerivedStateFromError(error: unknown) {
		return { error };
	}

	componentDidCatch(error: unknown) {
		const code = (error as { data?: { code?: unknown } }).data?.code;
		if (typeof code === "string" && code.startsWith("auth.")) return;
		posthog.captureException(error, {
			error_origin: "section_error_boundary",
			error_boundary: "payment link",
		});
	}

	render() {
		const { error } = this.state;
		if (!error) return this.props.children;
		const code = (error as { data?: { code?: unknown } }).data?.code;
		if (typeof code === "string" && code.startsWith("auth.")) {
			return (
				<PayNotice title="Your sign-in is still loading">
					Try again in a moment to open the payment.{" "}
					<button type="button" className="font-medium underline" onClick={() => this.setState({ error: null })}>
						Try again
					</button>
				</PayNotice>
			);
		}
		return (
			<PayNotice title="This link doesn't open a payment">
				The call or task it names doesn&apos;t exist, or isn&apos;t yours.
			</PayNotice>
		);
	}
}

/** What the payment is for, read from the call or task the link names. */
type Target =
	| {
			kind: "meeting";
			meetingId: Id<"meetings">;
			opportunityId: Id<"opportunities">;
			personName: string;
			canPay: boolean;
			href: string;
	  }
	| {
			kind: "task";
			followUpId: Id<"followUps">;
			personName: string;
			canPay: boolean;
			href: string;
	  };

function PayTarget({ link }: { link: PaymentLinkInput }) {
	const meetingId = link.meetingId as Id<"meetings"> | undefined;
	const followUpId = link.followUpId as Id<"followUps"> | undefined;
	// Right after a navigation the Convex client can run a query before it has
	// the session's token; wait for it rather than fail with auth.not_authenticated.
	const { isAuthenticated } = useConvexAuth();
	const meetingDetail = useQuery(
		api.closer.meetingDetail.getMeetingDetail,
		isAuthenticated && meetingId ? { meetingId } : "skip",
	);
	const taskDetail = useQuery(
		api.closer.reminderDetail.getReminderDetail,
		isAuthenticated && followUpId ? { followUpId } : "skip",
	);
	const programs = useQuery(
		api.tenantPrograms.queries.listPrograms,
		isAuthenticated ? { includeArchived: false } : "skip",
	);

	const detail = meetingId ? meetingDetail : taskDetail;
	if (detail === undefined || programs === undefined) return <PayPageSkeleton />;
	if (detail === null) {
		return (
			<PayNotice title="This link doesn't open a payment">
				The call or task it names doesn&apos;t exist, or isn&apos;t yours.
			</PayNotice>
		);
	}

	let target: Target;
	if (meetingId && meetingDetail) {
		const { meeting, opportunity, lead, activeFollowUp } = meetingDetail;
		target = {
			kind: "meeting",
			meetingId: meeting._id,
			opportunityId: opportunity._id,
			personName: lead.fullName ?? lead.email ?? "this person",
			canPay:
				meeting.status === "scheduled" &&
				isAwaitingOutcome(opportunity) &&
				activeFollowUp === null,
			href: `/workspace/closer/meetings/${meeting._id}`,
		};
	} else if (taskDetail) {
		const { followUp, opportunity, lead } = taskDetail;
		target = {
			kind: "task",
			followUpId: followUp._id,
			personName: lead.fullName ?? lead.email ?? "this person",
			canPay:
				followUp.status === "pending" &&
				followUp.type === "manual_reminder" &&
				followUp.reason !== "stale_opportunity_nudge" &&
				!isReminderDealFinished(opportunity),
			href: `/workspace/closer/reminders/${followUp._id}`,
		};
	} else {
		return <PayPageSkeleton />;
	}

	const program = programs.find((item) => item._id === link.programId);
	return <ReceiptForm link={link} target={target} programName={program?.name ?? null} />;
}

function ReceiptForm({
	link,
	target,
	programName,
}: {
	link: PaymentLinkInput;
	target: Target;
	programName: string | null;
}) {
	const [file, setFile] = useState<File | undefined>();
	const [fileError, setFileError] = useState<string | null>(null);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [logged, setLogged] = useState(false);

	const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
	const logPayment = useMutation(api.closer.payments.logPayment);
	const logReminderPayment = useMutation(api.closer.reminderOutcomes.logReminderPayment);
	// Whop already reporting this person's payment asks first; the page saves.
	const whopCheck = useWhopPaymentCheck(
		target.canPay
			? target.kind === "meeting"
				? { kind: "meeting", meetingId: target.meetingId }
				: { kind: "reminder", followUpId: target.followUpId }
			: null,
	);
	const whop = useWhopStepState<null>(true);
	const [attachedMessage, setAttachedMessage] = useState<string | null>(null);
	const marksAttendance = target.kind === "meeting";

	const editHref = buildPaymentDialogLink(link);
	const missing = [
		link.amount === undefined ? "the amount" : null,
		link.currency === undefined ? "the currency" : null,
		link.paymentType === undefined ? "the payment type" : null,
		programName === null ? "the program" : null,
	].filter((item): item is string => item !== null);

	if (logged) {
		return (
			<PayNotice title="Payment logged" success>
				The deal is won.{" "}
				<Link className="underline underline-offset-4" href={target.href}>
					{target.kind === "meeting" ? "Open the call" : "Open the task"}
				</Link>
			</PayNotice>
		);
	}

	if (attachedMessage) {
		return (
			<PayNotice title="Saved" success>
				{attachedMessage}{" "}
				<Link className="underline underline-offset-4" href={target.href}>
					{target.kind === "meeting" ? "Open the call" : "Open the task"}
				</Link>
			</PayNotice>
		);
	}

	const choose = (next: File | undefined) => {
		setSubmitError(null);
		setFileError(next ? proofFileProblem(next) : null);
		setFile(next);
	};

	const submit = async (answer: WhopAnswer | null = whop.answer) => {
		const need = answer
			? proofNeedFor(answer, { newMoney: true, roleNeedsProof: true, marksAttendance })
			: "required";
		if (!file && need === "required") {
			setFileError(PROOF_REQUIRED_MESSAGE);
			return;
		}
		const problem = file ? proofFileProblem(file) : null;
		if (problem) {
			setFileError(problem);
			return;
		}
		if (
			link.amount === undefined ||
			link.currency === undefined ||
			link.paymentType === undefined ||
			!link.programId
		) {
			return;
		}
		let uploadHttpStatus: number | undefined;
		setIsSubmitting(true);
		setSubmitError(null);
		try {
			let proofFileId: Id<"_storage"> | undefined;
			if (file) {
				const uploadUrl = await generateUploadUrl();
				const upload = await fetch(uploadUrl, {
					method: "POST",
					headers: { "Content-Type": file.type },
					body: file,
				});
				if (!upload.ok) {
					uploadHttpStatus = upload.status;
					throw new Error("Failed to upload the receipt");
				}
				const { storageId } = (await upload.json()) as { storageId?: string };
				if (!storageId) throw new Error("File upload returned invalid storage ID");
				proofFileId = storageId as Id<"_storage">;
			}
			const values = {
				amount: link.amount,
				currency: link.currency,
				programId: link.programId as Id<"tenantPrograms">,
				paymentType: link.paymentType,
				proofFileId,
				...(answer ? { provider: answer.intent } : {}),
			};
			if (target.kind === "meeting") {
				await logPayment({
					...values,
					opportunityId: target.opportunityId,
					meetingId: target.meetingId,
				});
			} else {
				await logReminderPayment({ ...values, followUpId: target.followUpId });
			}
			const attached = answer
				? whopSuccessMessage(answer, { marksAttendance, proofAttached: Boolean(proofFileId) })
				: null;
			if (attached) {
				toast.success(attached);
				setAttachedMessage(attached);
				return;
			}
			posthog.capture("payment_logged", {
				flow: "payment_link",
				target: target.kind,
				amount_minor: Math.round(link.amount * 100),
				currency: link.currency,
				program_id: link.programId,
				payment_type: link.paymentType,
				has_proof_file: Boolean(proofFileId),
				...(answer ? { whop_answer: answer.kind } : {}),
			});
			toast.success("Payment logged. The deal is won.");
			setLogged(true);
		} catch (error: unknown) {
			// Whop reports a payment the step must ask about, or the deal is full.
			if (whop.refused(error, null)) return;
			reportClientError(error, { flow: "payment_link_log", httpStatus: uploadHttpStatus });
			const message = getErrorMessage(error, "Failed to log payment. Please try again.");
			setSubmitError(message);
			toast.error(message);
		} finally {
			setIsSubmitting(false);
		}
	};

	const amountLabel =
		link.amount !== undefined && link.currency !== undefined
			? formatAmountMinor(Math.round(link.amount * 100), link.currency)
			: null;
	// The step shows the server's set after a refused save, else the pre-check's until answered.
	const stepConflicts =
		whop.shown?.conflicts ??
		(whopCheck.status === "found" && !whop.answer ? whopCheck.conflicts : null);
	const answer = whop.answer;
	const proofNeed = answer
		? proofNeedFor(answer, { newMoney: true, roleNeedsProof: true, marksAttendance })
		: "required";
	const attaching = answer?.kind === "same_money" && answer.existing;
	const actionLabel = attaching
		? marksAttendance
			? "Attach proof and mark the call attended"
			: "Attach proof"
		: "Log payment";

	return (
		<div className="mx-auto flex w-full max-w-md flex-col gap-4">
			<h1 className="text-xl font-semibold text-balance">
				Log {target.personName}&rsquo;s payment
			</h1>

			<Card>
				<CardHeader>
					<CardTitle className="text-3xl tabular-nums">{amountLabel ?? "—"}</CardTitle>
					<CardDescription>
						{target.kind === "meeting" ? "From the call" : "From the call-back task"}. Logging
						it closes the deal as won.
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
						<dt className="text-muted-foreground">Program</dt>
						<dd className="truncate font-medium">{programName ?? "—"}</dd>
						<dt className="text-muted-foreground">Type</dt>
						<dd className="font-medium">
							{link.paymentType ? PAYMENT_TYPE_LABELS[link.paymentType] : "—"}
						</dd>
					</dl>
					<Button asChild variant="outline" className="self-start">
						<Link href={editHref}>
							<PencilIcon data-icon="inline-start" aria-hidden="true" />
							Edit in full
						</Link>
					</Button>
				</CardContent>
			</Card>

			{/* The payment itself ends canPay; the form stays until it lands. */}
			{!target.canPay && !isSubmitting ? (
				<Alert variant="destructive">
					<AlertCircleIcon />
					<AlertDescription>
						This {target.kind === "meeting" ? "call" : "task"} can&apos;t take a payment now:
						its result is already recorded.{" "}
						<Link className="underline underline-offset-4" href={target.href}>
							Open it
						</Link>
					</AlertDescription>
				</Alert>
			) : missing.length > 0 ? (
				<Alert>
					<AlertCircleIcon />
					<AlertDescription>
						The link is missing {missing.join(", ")}. Use Edit in full to add{" "}
						{missing.length === 1 ? "it" : "them"}.
					</AlertDescription>
				</Alert>
			) : whop.capacityHeld ? (
				<div className="overflow-hidden rounded-xl border bg-card">
					<WhopCapacityHold variant="page" />
				</div>
			) : stepConflicts && link.amount !== undefined && link.currency !== undefined ? (
				<div className="overflow-hidden rounded-xl border bg-card">
					<WhopPaymentFoundStep
						variant="page"
						conflicts={stepConflicts}
						typed={{
							amountMinor: Math.round(link.amount * 100),
							currency: link.currency,
							paymentType: link.paymentType,
							programName,
						}}
						personName={target.personName}
						marksAttendance={marksAttendance}
						proofRules={{ newMoney: true, roleNeedsProof: true }}
						notice={whop.shown?.notice}
						error={whop.shown?.error ?? submitError}
						pending={isSubmitting}
						autoFocus={whop.shown !== null}
						onAnswer={(next) => {
							setSubmitError(null);
							setFileError(null);
							whop.choose(next, stepConflicts);
						}}
					/>
				</div>
			) : (
				<>
					{answer ? (
						<div className="flex items-baseline justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
							<span className="min-w-0">
								{answer.kind === "different_money"
									? "Different money from Whop’s payment."
									: attaching
										? "Already recorded from Whop. No second payment is added."
										: "The same money as Whop’s payment. They’re linked when you log it."}
							</span>
							<Button
								variant="link"
								size="sm"
								className="h-auto shrink-0 p-0"
								disabled={isSubmitting}
								onClick={() => whop.backFromConfirm(null)}
							>
								Change
							</Button>
						</div>
					) : null}
					{proofNeed === "waived" && !file ? (
						<p className="text-sm text-muted-foreground">
							No proof file is needed: the Whop payment is the proof.
						</p>
					) : (
						<ProofDropZone
							file={file}
							onChange={choose}
							disabled={isSubmitting}
							error={fileError}
						/>
					)}
					{submitError ? (
						<Alert variant="destructive">
							<AlertCircleIcon />
							<AlertDescription>{submitError}</AlertDescription>
						</Alert>
					) : null}
					<Button
						size="lg"
						className="h-12 w-full text-base font-semibold"
						disabled={isSubmitting}
						onClick={() => void submit()}
					>
						{isSubmitting ? (
							<>
								<Spinner data-icon="inline-start" />
								<TranslatableText>{attaching ? "Saving…" : "Logging…"}</TranslatableText>
							</>
						) : (
							<TranslatableText>{actionLabel}</TranslatableText>
						)}
					</Button>
				</>
			)}
		</div>
	);
}

function PayNotice({
	title,
	success,
	children,
}: {
	title: string;
	success?: boolean;
	children: React.ReactNode;
}) {
	return (
		<Empty className="mx-auto w-full max-w-md border">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					{success ? (
						<CheckCircle2Icon aria-hidden="true" />
					) : (
						<AlertCircleIcon aria-hidden="true" />
					)}
				</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
			</EmptyHeader>
			<EmptyContent>{children}</EmptyContent>
		</Empty>
	);
}
