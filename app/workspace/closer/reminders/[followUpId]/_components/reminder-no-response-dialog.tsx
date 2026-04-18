"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
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
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
	PhoneOffIcon,
	PhoneIcon,
	MessageSquareIcon,
	AlertCircleIcon,
} from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

// ---------------------------------------------------------------------------
// Schema — three-branch superRefine.
// When `nextStep === "schedule_new"` the scheduling sub-fields are required
// and the time must be in the future. Otherwise the sub-fields are ignored.
// ---------------------------------------------------------------------------

const noResponseSchema = z
	.object({
		nextStep: z.enum(["schedule_new", "give_up", "close_only"]),
		note: z.string().max(500, "Keep it under 500 characters").optional(),
		newContactMethod: z.enum(["call", "text"]).optional(),
		newReminderDate: z.string().optional(),
		newReminderTime: z.string().optional(),
		newReminderNote: z.string().max(500).optional(),
	})
	.superRefine((vals, ctx) => {
		if (vals.nextStep !== "schedule_new") return;

		if (!vals.newContactMethod) {
			ctx.addIssue({
				code: "custom",
				path: ["newContactMethod"],
				message: "Pick call or text",
			});
		}
		if (!vals.newReminderDate) {
			ctx.addIssue({
				code: "custom",
				path: ["newReminderDate"],
				message: "Date is required",
			});
		}
		if (!vals.newReminderTime) {
			ctx.addIssue({
				code: "custom",
				path: ["newReminderTime"],
				message: "Time is required",
			});
		}
		// Only validate the future-time check when both parts are provided;
		// otherwise the above field-level errors already point the user
		// somewhere useful.
		if (vals.newReminderDate && vals.newReminderTime) {
			const scheduled = new Date(
				`${vals.newReminderDate}T${vals.newReminderTime}`,
			).getTime();
			if (Number.isNaN(scheduled) || scheduled <= Date.now()) {
				ctx.addIssue({
					code: "custom",
					path: ["newReminderTime"],
					message: "Reminder time must be in the future",
				});
			}
		}
	});
type NoResponseFormValues = z.infer<typeof noResponseSchema>;

type Props = {
	followUpId: Id<"followUps">;
	// Accepted for future features (e.g. pre-filling the new reminder note
	// from the lead's most recent contact record). Not used in MVP but kept
	// in the prop signature so Phase 2-next doesn't need an action-bar
	// change to start using it.
	leadId: Id<"leads">;
	onSuccess: () => void;
};

// Branch-specific toast copy lives here rather than inline so the mapping is
// grep-able when the product team revisits the wording.
const BRANCH_SUCCESS_TOAST: Record<
	NoResponseFormValues["nextStep"],
	string
> = {
	schedule_new: "New reminder scheduled",
	give_up: "Opportunity marked as lost",
	close_only: "Reminder closed",
};

/**
 * Reminder No Response Dialog (Phase 5D)
 *
 * The three-path resolution dialog. Closer picks one of:
 *
 *   1. `schedule_new` — try again; creates a fresh pending reminder.
 *      Opens the scheduling sub-form (contact method + date + time +
 *      optional note). The original reminder is marked completed with
 *      outcome `no_response_rescheduled`.
 *
 *   2. `give_up`     — mark the underlying opportunity `lost`. The note
 *      field is re-labelled "Reason" since the text becomes the
 *      opportunity's `lostReason`.
 *
 *   3. `close_only`  — close just this reminder, leave the opportunity
 *      alone. Useful when the closer plans to take a different approach
 *      (e.g. wait for an inbound response) without committing to another
 *      scheduled attempt.
 *
 * Accessibility:
 *   - Outer RadioGroup items are wrapped in `<label>` so the full row is
 *     clickable (native HTML behaviour, no extra JS).
 *   - `aria-describedby` flows implicitly through shadcn's FormMessage.
 *   - The conditional scheduling sub-form is inside a bordered div so
 *     sighted users can see the containment; screen readers get the
 *     same structure via the nested FormLabel hierarchy.
 */
export function ReminderNoResponseDialog({ followUpId, onSuccess }: Props) {
	// `leadId` is accepted on `Props` but intentionally not destructured —
	// see the comment on the Props type for why it's plumbed through.
	const [open, setOpen] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);

	const markNoResponse = useMutation(
		api.closer.reminderOutcomes.markReminderNoResponse,
	);

	const form = useForm({
		resolver: standardSchemaResolver(noResponseSchema),
		defaultValues: {
			nextStep: "schedule_new" as const,
			note: "",
			newContactMethod: "call" as const,
			newReminderDate: "",
			newReminderTime: "",
			newReminderNote: "",
		},
	});

	// `watch` subscribes this component to the field. The conditional block
	// below re-renders only when `nextStep` changes, not on every keystroke
	// in other fields.
	const step = form.watch("nextStep");

	const closeAndReset = () => {
		setOpen(false);
		form.reset();
		setSubmitError(null);
	};

	const onSubmit = async (values: NoResponseFormValues) => {
		setIsSubmitting(true);
		setSubmitError(null);
		try {
			let reminderScheduledAt: number | undefined;
			if (values.nextStep === "schedule_new") {
				// superRefine already guarantees both parts exist at this point,
				// but TypeScript doesn't know that — assert via !.
				reminderScheduledAt = new Date(
					`${values.newReminderDate!}T${values.newReminderTime!}`,
				).getTime();
			}

			await markNoResponse({
				followUpId,
				nextStep: values.nextStep,
				note: values.note?.trim() || undefined,
				newReminder:
					values.nextStep === "schedule_new"
						? {
								contactMethod: values.newContactMethod!,
								reminderScheduledAt: reminderScheduledAt!,
								reminderNote:
									values.newReminderNote?.trim() || undefined,
							}
						: undefined,
			});

			posthog.capture("reminder_outcome_no_response", {
				follow_up_id: followUpId,
				next_step: values.nextStep,
				has_note: Boolean(values.note?.trim()),
				// Only meaningful when `schedule_new`; harmless otherwise.
				has_new_reminder_note: Boolean(values.newReminderNote?.trim()),
				new_contact_method:
					values.nextStep === "schedule_new"
						? values.newContactMethod
						: null,
			});

			toast.success(BRANCH_SUCCESS_TOAST[values.nextStep]);
			setOpen(false);
			form.reset();
			onSuccess();
		} catch (err) {
			posthog.captureException(err);
			const message =
				err instanceof Error ? err.message : "Failed to save";
			setSubmitError(message);
			toast.error(message);
		} finally {
			setIsSubmitting(false);
		}
	};

	// For the native <input type="date" /> `min` attribute — keeps the
	// picker from offering past days. The `superRefine` check is still the
	// real guard, but UX-wise this stops closers from fumbling.
	const todayIso = new Date().toISOString().split("T")[0];

	// Copy changes based on `step`. Keeps the note field repurposed cleanly
	// across branches without duplicating the whole field block.
	const noteLabel =
		step === "give_up" ? "Reason (optional)" : "Note (optional)";
	const notePlaceholder =
		step === "give_up"
			? "Why did this deal fall through? (e.g., went with a competitor)"
			: step === "schedule_new"
				? "Anything to remember before the next attempt?"
				: "Optional context for yourself…";

	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (isSubmitting) return; // don't dismiss mid-submit
				setOpen(value);
				if (!value) {
					form.reset();
					setSubmitError(null);
				}
			}}
		>
			<DialogTrigger asChild>
				<Button variant="outline" size="lg">
					<PhoneOffIcon data-icon="inline-start" />
					No Response
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>No response — what next?</DialogTitle>
					<DialogDescription>
						Pick what to do with this reminder and the underlying
						opportunity.
					</DialogDescription>
				</DialogHeader>

				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="flex flex-col gap-4"
					>
						<FormField
							control={form.control}
							name="nextStep"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Choose a next step</FormLabel>
									<FormControl>
										<RadioGroup
											value={field.value}
											onValueChange={field.onChange}
											className="flex flex-col gap-2"
										>
											<ChoiceRow
												value="schedule_new"
												title="Try again — schedule a new reminder"
												description="Keeps the opportunity alive. Creates a fresh reminder."
											/>
											<ChoiceRow
												value="close_only"
												title="Close this reminder only"
												description="Decide later. Opportunity stays untouched."
											/>
											<ChoiceRow
												value="give_up"
												title="Give up — mark opportunity lost"
												description="Transitions the opportunity to lost."
											/>
										</RadioGroup>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						{/* Conditional scheduling sub-form. Kept inside a bordered
						    container so the grouping is visually unambiguous. */}
						{step === "schedule_new" && (
							<div className="flex flex-col gap-3 rounded-lg border p-3">
								<FormField
									control={form.control}
									name="newContactMethod"
									render={({ field }) => (
										<FormItem>
											<FormLabel>
												How?{" "}
												<span className="text-destructive">*</span>
											</FormLabel>
											<FormControl>
												<ToggleGroup
													type="single"
													value={field.value}
													onValueChange={(value) => {
														if (value) field.onChange(value);
													}}
													className="justify-start"
													disabled={isSubmitting}
												>
													<ToggleGroupItem
														value="call"
														aria-label="Call"
													>
														<PhoneIcon data-icon="inline-start" />
														Call
													</ToggleGroupItem>
													<ToggleGroupItem
														value="text"
														aria-label="Text"
													>
														<MessageSquareIcon data-icon="inline-start" />
														Text
													</ToggleGroupItem>
												</ToggleGroup>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>

								<div className="grid grid-cols-2 gap-3">
									<FormField
										control={form.control}
										name="newReminderDate"
										render={({ field }) => (
											<FormItem>
												<FormLabel>
													Date{" "}
													<span className="text-destructive">
														*
													</span>
												</FormLabel>
												<FormControl>
													<Input
														type="date"
														min={todayIso}
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
										name="newReminderTime"
										render={({ field }) => (
											<FormItem>
												<FormLabel>
													Time{" "}
													<span className="text-destructive">
														*
													</span>
												</FormLabel>
												<FormControl>
													<Input
														type="time"
														disabled={isSubmitting}
														{...field}
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
								</div>

								<FormField
									control={form.control}
									name="newReminderNote"
									render={({ field }) => (
										<FormItem>
											<FormLabel>
												Note for next time (optional)
											</FormLabel>
											<FormControl>
												<Textarea
													rows={2}
													placeholder="e.g., Mention the Q4 discount"
													disabled={isSubmitting}
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							</div>
						)}

						<FormField
							control={form.control}
							name="note"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{noteLabel}</FormLabel>
									<FormControl>
										<Textarea
											rows={3}
											placeholder={notePlaceholder}
											disabled={isSubmitting}
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						{submitError && (
							<Alert variant="destructive">
								<AlertCircleIcon />
								<AlertDescription>{submitError}</AlertDescription>
							</Alert>
						)}

						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								disabled={isSubmitting}
								onClick={closeAndReset}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={isSubmitting}>
								{isSubmitting ? (
									<>
										<Spinner data-icon="inline-start" />
										Saving…
									</>
								) : (
									"Save"
								)}
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
}

// ─── Internal ────────────────────────────────────────────────────────────────

/**
 * One row of the outer RadioGroup. Wraps the radio + copy in a `<label>`
 * so clicking anywhere on the row selects the option. Native HTML wiring
 * — no extra JS, no `onClick` handler on the wrapper.
 */
function ChoiceRow({
	value,
	title,
	description,
}: {
	value: "schedule_new" | "give_up" | "close_only";
	title: string;
	description: string;
}) {
	return (
		<label className="hover:bg-muted/50 flex cursor-pointer items-start gap-2 rounded-md p-2 transition-colors">
			<RadioGroupItem value={value} className="mt-0.5" />
			<div className="min-w-0">
				<div className="text-sm font-medium">{title}</div>
				<div className="text-muted-foreground text-xs">{description}</div>
			</div>
		</label>
	);
}
