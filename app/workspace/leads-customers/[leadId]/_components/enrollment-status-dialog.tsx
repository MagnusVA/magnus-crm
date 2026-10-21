"use client";

import { useMutation } from "convex/react";
import { useForm, useWatch } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import {
	ENROLLMENT_STATUS_LABELS,
	type EnrollmentStatus,
} from "@/convex/enrollments/validators";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { getErrorMessage } from "@/lib/errors";
import type { EntityDetailEnrollment } from "./entity-detail-context";
import { announceStatusOutcome } from "./enrollment-status-outcome";

const REASON_MAX_LENGTH = 500;

const reasonSchema = z.object({
	reason: z
		.string()
		.trim()
		.max(REASON_MAX_LENGTH, `Keep the reason to ${REASON_MAX_LENGTH} characters`),
});

// Pausing or churning a program asks for an optional reason, which the
// person's timeline shows with the change (docs/plans/phase-4-customers.md §4.4).
export function EnrollmentStatusDialog({
	open,
	onOpenChange,
	enrollment,
	status,
	expectedStatus,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	enrollment: EntityDetailEnrollment;
	status: "paused" | "churned";
	// The status the page showed when the select changed; a change since makes
	// the request stale.
	expectedStatus: EnrollmentStatus;
}) {
	const updateStatus = useMutation(api.enrollments.mutations.updateEnrollmentStatus);
	const form = useForm({
		resolver: standardSchemaResolver(reasonSchema),
		defaultValues: { reason: "" },
	});
	const isSubmitting = form.formState.isSubmitting;
	const reasonLength = useWatch({ control: form.control, name: "reason" }).length;
	const label = ENROLLMENT_STATUS_LABELS[status];

	const onSubmit = async (values: z.infer<typeof reasonSchema>) => {
		try {
			const outcome = await updateStatus({
				enrollmentId: enrollment.enrollmentId,
				status,
				reason: values.reason || undefined,
				expectedStatus,
			});
			announceStatusOutcome(outcome, enrollment.programName, status);
			form.reset();
			onOpenChange(false);
		} catch (error) {
			toast.error(getErrorMessage(error, "Couldn't change the program's status"));
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!isSubmitting) {
					if (!nextOpen) form.reset();
					onOpenChange(nextOpen);
				}
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>
						{status === "paused" ? "Pause" : "Churn"} {enrollment.programName}
					</DialogTitle>
					<DialogDescription>
						The program will show as {label}. The reason, if you give one, appears on the
						person&apos;s timeline with the change.
					</DialogDescription>
				</DialogHeader>

				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6">
						<FormField
							control={form.control}
							name="reason"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Reason (optional)</FormLabel>
									<FormControl>
										<Textarea
											rows={3}
											maxLength={REASON_MAX_LENGTH}
											disabled={isSubmitting}
											{...field}
										/>
									</FormControl>
									<FormDescription className="text-right tabular-nums">
										{reasonLength}/{REASON_MAX_LENGTH}
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								disabled={isSubmitting}
								onClick={() => onOpenChange(false)}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={isSubmitting}>
								{isSubmitting ? <Spinner /> : null}
								Set to {label}
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
}
