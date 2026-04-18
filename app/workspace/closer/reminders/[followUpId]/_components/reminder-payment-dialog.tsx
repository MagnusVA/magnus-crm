"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { FieldGroup } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { BanknoteIcon, AlertCircleIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

// ---------------------------------------------------------------------------
// Constants — kept in sync with the meeting `PaymentFormDialog` so closers
// see the same providers and currencies regardless of which flow they use.
// ---------------------------------------------------------------------------

/** Max proof file size: 10 MB (Convex free-tier friendly + server enforces). */
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const VALID_FILE_TYPES = [
	"image/jpeg",
	"image/png",
	"image/gif",
	"application/pdf",
];

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] as const;
const PROVIDERS = [
	"Stripe",
	"PayPal",
	"Square",
	"Cash",
	"Bank Transfer",
	"Other",
] as const;

// ---------------------------------------------------------------------------
// Zod schema — single source of truth for form validation.
// ---------------------------------------------------------------------------

const paymentFormSchema = z.object({
	amount: z
		.string()
		.min(1, "Amount is required")
		.refine(
			(val) => {
				const num = parseFloat(val);
				return !Number.isNaN(num) && num > 0;
			},
			{ message: "Amount must be greater than 0" },
		),
	currency: z.enum(CURRENCIES),
	provider: z.enum(PROVIDERS, { error: "Please select a payment provider" }),
	referenceCode: z.string().optional(),
	proofFile: z
		.instanceof(File)
		.optional()
		.refine(
			(file) => !file || file.size <= MAX_FILE_SIZE,
			"File size must be less than 10 MB",
		)
		.refine(
			(file) => !file || VALID_FILE_TYPES.includes(file.type),
			"Only images (JPEG, PNG, GIF) and PDFs are allowed",
		),
});
type PaymentFormValues = z.infer<typeof paymentFormSchema>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Props = {
	followUpId: Id<"followUps">;
	onSuccess: () => void;
};

/**
 * Reminder Payment Dialog (Phase 5B)
 *
 * Parallel to the meeting `PaymentFormDialog` but hooked into the
 * reminder mutation. Backend resolves `meetingId` from the follow-up
 * (see `convex/closer/reminderOutcomes.ts :: logReminderPayment`); we
 * do NOT pass it here.
 *
 * Two-step Convex storage upload:
 *   1. `generateUploadUrl()` → short-lived URL
 *   2. `fetch(uploadUrl, { method: "POST", body: file })` → `storageId`
 *   3. Hand `storageId` to the mutation as `proofFileId`
 *
 * On success the dialog closes, a toast fires, and `onSuccess` is
 * invoked — the parent navigates back to the dashboard. On failure we
 * keep the dialog open, preserve form state, and surface the error in
 * both a toast and an inline Alert.
 */
export function ReminderPaymentDialog({ followUpId, onSuccess }: Props) {
	// Dialog open/close — kept outside RHF (not a form field).
	const [open, setOpen] = useState(false);
	// Submission loading flag — drives spinner + disabled states.
	const [isSubmitting, setIsSubmitting] = useState(false);
	// Submission-level error (network / Convex). Separate from Zod errors.
	const [submitError, setSubmitError] = useState<string | null>(null);

	const form = useForm({
		resolver: standardSchemaResolver(paymentFormSchema),
		defaultValues: {
			amount: "",
			currency: "USD" as const,
			provider: undefined,
			referenceCode: "",
			proofFile: undefined,
		},
	});

	const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
	const logReminderPayment = useMutation(
		api.closer.reminderOutcomes.logReminderPayment,
	);

	const onSubmit = async (values: PaymentFormValues) => {
		setIsSubmitting(true);
		setSubmitError(null);
		try {
			// Optional proof file — upload to Convex storage first.
			let proofFileId: Id<"_storage"> | undefined;
			if (values.proofFile) {
				const uploadUrl = await generateUploadUrl();
				const uploadResponse = await fetch(uploadUrl, {
					method: "POST",
					headers: { "Content-Type": values.proofFile.type },
					body: values.proofFile,
				});
				if (!uploadResponse.ok) {
					throw new Error("Failed to upload proof file");
				}
				const uploadData = (await uploadResponse.json()) as {
					storageId?: string;
				};
				if (!uploadData.storageId) {
					throw new Error("File upload returned invalid storage ID");
				}
				proofFileId = uploadData.storageId as Id<"_storage">;
			}

			// Parse amount once — the backend converts to `amountMinor` via
			// `toAmountMinor` so we pass the major-unit value (e.g. 299.99).
			const parsedAmount = parseFloat(values.amount);
			const paymentId = await logReminderPayment({
				followUpId,
				amount: parsedAmount,
				currency: values.currency,
				provider: values.provider,
				referenceCode: values.referenceCode?.trim() || undefined,
				proofFileId,
			});

			// PostHog — snake_case, no PII. The `amount_minor` property keeps
			// parity with the meeting flow's `payment_logged` event so analytics
			// can union the two sources.
			posthog.capture("reminder_outcome_payment", {
				follow_up_id: followUpId,
				payment_id: paymentId,
				amount_minor: Math.round(parsedAmount * 100),
				currency: values.currency,
				provider: values.provider,
				has_reference_code: Boolean(values.referenceCode?.trim()),
				has_proof: Boolean(proofFileId),
			});

			toast.success("Payment logged successfully");
			setOpen(false);
			form.reset();
			onSuccess();
		} catch (err: unknown) {
			posthog.captureException(err);
			const message =
				err instanceof Error
					? err.message
					: "Failed to log payment. Please try again.";
			setSubmitError(message);
			toast.error(message);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				// Prevent dismiss mid-submit so the toast result isn't missed.
				if (isSubmitting) return;
				setOpen(value);
				if (!value) {
					form.reset();
					setSubmitError(null);
				}
			}}
		>
			<DialogTrigger asChild>
				<Button size="lg">
					<BanknoteIcon data-icon="inline-start" />
					Log Payment
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Log payment</DialogTitle>
					<DialogDescription>
						Record a payment to mark this opportunity as won.
					</DialogDescription>
				</DialogHeader>

				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)}>
						<FieldGroup>
							<FormField
								control={form.control}
								name="amount"
								render={({ field }) => (
									<FormItem>
										<FormLabel>
											Amount <span className="text-destructive">*</span>
										</FormLabel>
										<FormControl>
											<Input
												type="number"
												step="0.01"
												min="0"
												inputMode="decimal"
												placeholder="299.99"
												disabled={isSubmitting}
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="currency"
								render={({ field }) => (
									<FormItem>
										<FormLabel>
											Currency <span className="text-destructive">*</span>
										</FormLabel>
										<Select
											onValueChange={field.onChange}
											value={field.value}
											disabled={isSubmitting}
										>
											<FormControl>
												<SelectTrigger>
													<SelectValue />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												<SelectGroup>
													{CURRENCIES.map((c) => (
														<SelectItem key={c} value={c}>
															{c}
														</SelectItem>
													))}
												</SelectGroup>
											</SelectContent>
										</Select>
										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="provider"
								render={({ field }) => (
									<FormItem>
										<FormLabel>
											Provider <span className="text-destructive">*</span>
										</FormLabel>
										<Select
											onValueChange={field.onChange}
											value={field.value}
											disabled={isSubmitting}
										>
											<FormControl>
												<SelectTrigger>
													<SelectValue placeholder="Select provider" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												<SelectGroup>
													{PROVIDERS.map((p) => (
														<SelectItem key={p} value={p}>
															{p}
														</SelectItem>
													))}
												</SelectGroup>
											</SelectContent>
										</Select>
										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="referenceCode"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Fathom Link</FormLabel>
										<FormControl>
											<Input
												type="url"
												placeholder="https://app.fathom.video/share/..."
												disabled={isSubmitting}
												{...field}
											/>
										</FormControl>
										<FormDescription>
											Link to the Fathom call recording (optional).
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="proofFile"
								// File inputs can't have values set programmatically —
								// destructure `value` off and pass `onChange` manually.
								render={({ field: { value, onChange, ...fieldProps } }) => (
									<FormItem>
										<FormLabel>Proof File</FormLabel>
										<FormControl>
											<Input
												type="file"
												accept={VALID_FILE_TYPES.join(",")}
												disabled={isSubmitting}
												onChange={(e) => onChange(e.target.files?.[0])}
												{...fieldProps}
											/>
										</FormControl>
										{value && (
											<div className="text-muted-foreground flex items-center gap-1.5 text-xs">
												<UploadIcon className="size-3 shrink-0" />
												<span className="truncate">
													{value.name} ({(value.size / 1024).toFixed(1)} KB)
												</span>
											</div>
										)}
										<FormDescription>
											Max 10 MB. Allowed: PNG, JPEG, GIF, PDF.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						</FieldGroup>

						{submitError && (
							<Alert variant="destructive" className="mt-4">
								<AlertCircleIcon />
								<AlertDescription>{submitError}</AlertDescription>
							</Alert>
						)}

						<DialogFooter className="mt-5">
							<Button
								type="button"
								variant="ghost"
								onClick={() => {
									setOpen(false);
									form.reset();
									setSubmitError(null);
								}}
								disabled={isSubmitting}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={isSubmitting}>
								{isSubmitting ? (
									<>
										<Spinner data-icon="inline-start" />
										Logging...
									</>
								) : (
									"Log Payment"
								)}
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
}
