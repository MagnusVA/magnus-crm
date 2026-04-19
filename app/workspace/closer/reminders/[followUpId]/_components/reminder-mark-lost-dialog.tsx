"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { AlertTriangleIcon, XCircleIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

// Schema mirrors the meeting `MarkLostDialog` so lost-reason
// conventions stay consistent across the two entry points.
const markLostSchema = z.object({
	reason: z
		.string()
		.max(500, "Reason must be under 500 characters")
		.optional(),
});
type MarkLostFormValues = z.infer<typeof markLostSchema>;

type Props = {
	followUpId: Id<"followUps">;
	onSuccess: () => void;
};

/**
 * Reminder Mark Lost Dialog (Phase 5C)
 *
 * Confirmation dialog for marking the underlying opportunity as lost
 * while closing out the reminder. Wraps `api.closer.reminderOutcomes.
 * markReminderLost`.
 *
 * Why AlertDialog (not Dialog)?
 *   - The action is terminal: it transitions the opportunity to
 *     `lost` and marks the reminder `completed`. AlertDialog's
 *     stricter focus-trap + ESC-to-cancel UX is the right fit.
 *
 * Why nest `<Button type="submit">` inside the form instead of using
 * `AlertDialogAction asChild`?
 *   - `AlertDialogAction` closes the dialog before the form submits,
 *     which would skip the mutation + toast. The meeting detail
 *     `MarkLostDialog` uses the same pattern — keeping the two in
 *     sync means closers get identical UX from both entry points.
 */
export function ReminderMarkLostDialog({ followUpId, onSuccess }: Props) {
	const [open, setOpen] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const markReminderLost = useMutation(
		api.closer.reminderOutcomes.markReminderLost,
	);

	const form = useForm({
		resolver: standardSchemaResolver(markLostSchema),
		defaultValues: { reason: "" },
	});

	const onSubmit = async (values: MarkLostFormValues) => {
		setIsLoading(true);
		try {
			const trimmedReason = values.reason?.trim() || undefined;
			await markReminderLost({ followUpId, reason: trimmedReason });

			posthog.capture("reminder_outcome_lost", {
				follow_up_id: followUpId,
				has_reason: Boolean(trimmedReason),
			});
			toast.success("Opportunity marked as lost");
			setOpen(false);
			form.reset();
			onSuccess();
		} catch (err) {
			posthog.captureException(err);
			toast.error(
				err instanceof Error ? err.message : "Failed to mark as lost",
			);
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<>
			{/* Trigger lives outside the AlertDialog so the parent action-bar
			    can size it via the [&_button]:w-full descendant selector. */}
			<Button
				variant="outline"
				size="lg"
				onClick={() => setOpen(true)}
				className="text-destructive hover:text-destructive"
			>
				<XCircleIcon data-icon="inline-start" />
				Mark as Lost
			</Button>

			<AlertDialog
				open={open}
				onOpenChange={(value) => {
					if (isLoading) return; // don't dismiss mid-submit
					setOpen(value);
					if (!value) form.reset();
				}}
			>
				<AlertDialogContent className="max-w-md">
					<AlertDialogHeader>
						<div className="flex items-start gap-3">
							<div className="bg-destructive/10 flex size-8 shrink-0 items-center justify-center rounded-lg">
								<AlertTriangleIcon className="text-destructive size-4" />
							</div>
							<div className="flex-1">
								<AlertDialogTitle>Mark as Lost?</AlertDialogTitle>
								<AlertDialogDescription>
									The opportunity will transition to <b>lost</b> and
									this reminder will be completed. You can add an
									optional reason.
								</AlertDialogDescription>
							</div>
						</div>
					</AlertDialogHeader>

					<Form {...form}>
						<form onSubmit={form.handleSubmit(onSubmit)}>
							<FormField
								control={form.control}
								name="reason"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Reason (optional)</FormLabel>
										<FormControl>
											<Textarea
												placeholder="Why did this deal fall through? (e.g., budget constraints, chose competitor…)"
												className="min-h-[100px] resize-none text-sm"
												disabled={isLoading}
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>

							<AlertDialogFooter className="mt-4">
								<AlertDialogCancel disabled={isLoading}>
									Cancel
								</AlertDialogCancel>
								<Button
									type="submit"
									variant="destructive"
									disabled={isLoading}
								>
									{isLoading ? (
										<>
											<Spinner data-icon="inline-start" />
											Marking…
										</>
									) : (
										"Mark as Lost"
									)}
								</Button>
							</AlertDialogFooter>
						</form>
					</Form>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
