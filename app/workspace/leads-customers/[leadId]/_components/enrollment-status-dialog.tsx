"use client";

import { useId } from "react";
import { useMutation } from "convex/react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import {
	ENROLLMENT_STATUS_LABELS,
	type EnrollmentStatus,
} from "@/convex/enrollments/validators";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { getErrorMessage } from "@/lib/errors";
import { firstNameOf } from "@/app/workspace/closer/meetings/_components/meeting-detail-types";
import {
	ACTION_DIALOG,
	ACTION_FORM,
	ActionDialogFooter,
	ActionDialogHeader,
	CancelButton,
	FormRow,
	FormRows,
	SubmitButton,
} from "@/app/workspace/_components/action-dialog";
import { useEntityDetail, type EntityDetailEnrollment } from "./entity-detail-context";
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
	const { lead } = useEntityDetail();
	const reasonId = useId();
	const updateStatus = useMutation(api.enrollments.mutations.updateEnrollmentStatus);
	const form = useForm({
		resolver: standardSchemaResolver(reasonSchema),
		defaultValues: { reason: "" },
	});
	const isSubmitting = form.formState.isSubmitting;
	const reasonLength = useWatch({ control: form.control, name: "reason" }).length;
	const label = ENROLLMENT_STATUS_LABELS[status];
	const name = lead.fullName ?? lead.email ?? null;
	const firstName = firstNameOf(lead.fullName);

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
			<DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
				<ActionDialogHeader
					title={
						<>
							{status === "paused" ? "Pause" : "Churn"}{" "}
							{name ? (
								<>
									<span translate="no">{name}</span>&rsquo;s{" "}
								</>
							) : null}
							{enrollment.programName}
						</>
					}
					description={`The program will show as ${label}.`}
				/>
				<form onSubmit={form.handleSubmit(onSubmit)} className={ACTION_FORM}>
					<FormRows>
						<Controller
							control={form.control}
							name="reason"
							render={({ field, fieldState }) => (
								<FormRow
									label="Reason"
									htmlFor={reasonId}
									invalid={fieldState.invalid}
									error={fieldState.error}
									description={
										<span className="flex justify-between gap-3">
											<span>Optional. Shown on {firstName ?? "the person"}&rsquo;s timeline with the change.</span>
											<span className="shrink-0 tabular-nums">
												{reasonLength}/{REASON_MAX_LENGTH}
											</span>
										</span>
									}
								>
									<Textarea
										{...field}
										id={reasonId}
										aria-invalid={fieldState.invalid}
										rows={3}
										className="max-h-48 resize-none"
										maxLength={REASON_MAX_LENGTH}
										disabled={isSubmitting}
									/>
								</FormRow>
							)}
						/>
					</FormRows>
					<ActionDialogFooter>
						<CancelButton onClick={() => onOpenChange(false)} disabled={isSubmitting} />
						<SubmitButton pending={isSubmitting} pendingLabel="Saving…">
							Set to {label}
						</SubmitButton>
					</ActionDialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
