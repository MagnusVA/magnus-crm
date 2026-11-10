"use client";

import { useId, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import {
	ACTION_DIALOG,
	ACTION_FORM,
	ActionDialogFooter,
	ActionDialogHeader,
	CancelButton,
	FormRow,
	FormRows,
	SubmitButton,
	SubmitError,
} from "@/app/workspace/_components/action-dialog";
import { useEntityDetail } from "./entity-detail-context";
import { personDate } from "./person-format";

const nameSchema = z.object({
	fullName: z
		.string()
		.trim()
		.min(1, "Enter a name")
		.max(200, "Keep the name to 200 characters"),
	qualificationEventIds: z.array(z.string()),
});

/**
 * An admin corrects a person's name (`leads.nameAdmin.renamePerson`) and the
 * name typed on the person's Slack submissions, which the Qualifications list,
 * reports and Slack reminders show.
 */
export function EditNameDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { lead } = useEntityDetail();
	const ids = useId();
	const { setting } = useBusinessDay();
	const now = useNow();
	const [submitError, setSubmitError] = useState<string | null>(null);
	const submissions = useQuery(api.leads.nameAdmin.listQualificationNames, { leadId: lead._id });
	const renamePerson = useMutation(api.leads.nameAdmin.renamePerson);
	const form = useForm({
		resolver: standardSchemaResolver(nameSchema),
		defaultValues: { fullName: lead.fullName ?? "", qualificationEventIds: [] as string[] },
	});
	const isSubmitting = form.formState.isSubmitting;
	const typedName = useWatch({ control: form.control, name: "fullName" }).trim();
	// Submissions already under the typed name have nothing to correct.
	const differing = (submissions ?? []).filter((submission) => submission.fullNameSnapshot !== typedName);

	const close = () => {
		form.reset();
		setSubmitError(null);
		onOpenChange(false);
	};

	const onSubmit = async (values: z.infer<typeof nameSchema>) => {
		setSubmitError(null);
		const differingIds = new Set(differing.map((submission) => submission.qualificationEventId as string));
		try {
			await renamePerson({
				leadId: lead._id,
				fullName: values.fullName,
				qualificationEventIds: values.qualificationEventIds.filter((id) =>
					differingIds.has(id),
				) as Id<"slackQualificationEvents">[],
			});
			toast.success("Name saved");
			close();
		} catch (error) {
			setSubmitError(getErrorMessage(error, "Couldn't save the name"));
			reportClientError(error, { flow: "lead_rename" });
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (isSubmitting) return;
				if (nextOpen) onOpenChange(true);
				else close();
			}}
		>
			<DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
				<ActionDialogHeader
					title="Edit name"
					description="Changes the name everywhere the CRM shows this person."
				/>
				<form onSubmit={form.handleSubmit(onSubmit)} className={ACTION_FORM}>
					<SubmitError>{submitError}</SubmitError>
					<FormRows>
						<Controller
							control={form.control}
							name="fullName"
							render={({ field, fieldState }) => (
								<FormRow
									label="Name"
									htmlFor={`${ids}-name`}
									invalid={fieldState.invalid}
									error={fieldState.error}
								>
									<Input
										{...field}
										id={`${ids}-name`}
										aria-invalid={fieldState.invalid}
										autoComplete="off"
										disabled={isSubmitting}
										translate="no"
									/>
								</FormRow>
							)}
						/>
						{differing.length > 0 ? (
							<Controller
								control={form.control}
								name="qualificationEventIds"
								render={({ field }) => (
									<FormRow
										label="Slack submissions"
										description="Pick the ones sent under the wrong name. They take the name above in Qualifications, reports and Slack reminders."
									>
										<ul className="flex flex-col gap-2">
											{differing.map((submission) => {
												const id = submission.qualificationEventId as string;
												const checkboxId = `${ids}-${id}`;
												return (
													<li key={id} className="flex items-start gap-2">
														<Checkbox
															id={checkboxId}
															className="mt-0.5"
															checked={field.value.includes(id)}
															disabled={isSubmitting}
															onCheckedChange={(checked) =>
																field.onChange(
																	checked === true
																		? [...field.value, id]
																		: field.value.filter((value) => value !== id),
																)
															}
														/>
														<label htmlFor={checkboxId} className="min-w-0 text-[13px] leading-[1.45]">
															<span className="line-clamp-2 wrap-break-word" translate="no">
																{submission.fullNameSnapshot || "No name"}
															</span>
															<span className="text-muted-foreground" suppressHydrationWarning>
																Sent {personDate(submission.submittedAt, setting, now)}
															</span>
														</label>
													</li>
												);
											})}
										</ul>
									</FormRow>
								)}
							/>
						) : null}
					</FormRows>
					<ActionDialogFooter>
						<CancelButton onClick={close} disabled={isSubmitting} />
						<SubmitButton pending={isSubmitting} pendingLabel="Saving…">
							Save name
						</SubmitButton>
					</ActionDialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
