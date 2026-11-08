"use client";

import { useId, useState } from "react";
import { useMutation } from "convex/react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
	DISPOSITION_LABELS,
	LIFECYCLE_STAGE_LABELS,
	LIFECYCLE_STAGES,
	stageIndex,
	type Disposition,
	type LifecycleStage,
} from "@/convex/leads/lifecycle";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
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
	SubmitError,
} from "@/app/workspace/_components/action-dialog";
import { useEntityDetail } from "./entity-detail-context";

const changeSchema = z.object({
	target: z.string().min(1, "Pick one"),
	reason: z
		.string()
		.trim()
		.min(1, "Say why")
		.max(500, "Keep the reason to 500 characters"),
});

export type LifecycleChangeMode = "move_back" | "disposition";

/** "Booked, Showed and Customer". */
function joinWords(words: string[]) {
	return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** What moving back to `target` drops, stated before Move back confirms it. */
function moveBackConsequence(stage: LifecycleStage, target: LifecycleStage | null, firstName: string) {
	if (!target) {
		return `Later stages stop counting until ${firstName} reaches them again.`;
	}
	const dropped = LIFECYCLE_STAGES.slice(stageIndex(target) + 1, stageIndex(stage) + 1).map(
		(option) => LIFECYCLE_STAGE_LABELS[option],
	);
	return dropped.length === 1
		? `${dropped[0]} stops counting until ${firstName} reaches it again.`
		: `${joinWords(dropped)} stop counting until ${firstName} reaches them again.`;
}

/**
 * An admin corrects a person's lifecycle on the person page: moves the stage
 * back (`leads.lifecycleAdmin.moveLifecycleStageBack`) or sets the
 * disposition (`setDisposition`), with a reason either way.
 */
export function LifecycleChangeDialog({
	open,
	onOpenChange,
	mode,
	leadId,
	stage,
	disposition,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mode: LifecycleChangeMode;
	leadId: Id<"leads">;
	stage: LifecycleStage;
	disposition: Disposition;
}) {
	const { lead } = useEntityDetail();
	const ids = useId();
	const [submitError, setSubmitError] = useState<string | null>(null);
	const moveBack = useMutation(api.leads.lifecycleAdmin.moveLifecycleStageBack);
	const setDisposition = useMutation(api.leads.lifecycleAdmin.setDisposition);
	const form = useForm({
		resolver: standardSchemaResolver(changeSchema),
		defaultValues: { target: "", reason: "" },
	});
	const isSubmitting = form.formState.isSubmitting;
	const target = useWatch({ control: form.control, name: "target" });

	const name = lead.fullName ?? lead.email ?? "this person";
	const firstName = firstNameOf(lead.fullName) ?? "the person";

	const options =
		mode === "move_back"
			? LIFECYCLE_STAGES.filter((option) => stageIndex(option) < stageIndex(stage)).map(
					(option) => ({ value: option, label: LIFECYCLE_STAGE_LABELS[option] }),
				)
			: (Object.keys(DISPOSITION_LABELS) as Disposition[])
					.filter((option) => option !== disposition)
					.map((option) => ({ value: option, label: DISPOSITION_LABELS[option] }));

	const onSubmit = async (values: z.infer<typeof changeSchema>) => {
		setSubmitError(null);
		try {
			if (mode === "move_back") {
				await moveBack({ leadId, toStage: values.target as LifecycleStage, reason: values.reason });
				toast.success(`Moved back to ${LIFECYCLE_STAGE_LABELS[values.target as LifecycleStage]}`);
			} else {
				await setDisposition({ leadId, disposition: values.target as Disposition, reason: values.reason });
				toast.success(`Disposition set to ${DISPOSITION_LABELS[values.target as Disposition]}`);
			}
			form.reset();
			onOpenChange(false);
		} catch (error) {
			setSubmitError(getErrorMessage(error, "Couldn't save the change"));
			reportClientError(error, { flow: `lead_lifecycle_${mode}` });
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!isSubmitting) {
					if (!nextOpen) {
						form.reset();
						setSubmitError(null);
					}
					onOpenChange(nextOpen);
				}
			}}
		>
			<DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
				<ActionDialogHeader
					title={
						mode === "move_back" ? (
							<>
								Move <span translate="no">{name}</span> back a stage
							</>
						) : (
							<>
								Set <span translate="no">{name}</span>&rsquo;s disposition
							</>
						)
					}
					description={
						mode === "move_back"
							? "For a stage the records got wrong."
							: `Whether the team should keep working ${firstName}.`
					}
				/>
				<form onSubmit={form.handleSubmit(onSubmit)} className={ACTION_FORM}>
					<SubmitError>{submitError}</SubmitError>
					<FormRows>
						<Controller
							control={form.control}
							name="target"
							render={({ field, fieldState }) => (
								<FormRow
									label={mode === "move_back" ? "New stage" : "Disposition"}
									htmlFor={`${ids}-target`}
									invalid={fieldState.invalid}
									error={fieldState.error}
									description={
										mode === "move_back"
											? moveBackConsequence(stage, (field.value || null) as LifecycleStage | null, firstName)
											: "Only an admin can change it after this."
									}
								>
									<Select value={field.value} onValueChange={field.onChange} disabled={isSubmitting}>
										<SelectTrigger
											id={`${ids}-target`}
											ref={field.ref}
											onBlur={field.onBlur}
											aria-invalid={fieldState.invalid}
											className="w-full"
										>
											<SelectValue placeholder="Choose…" />
										</SelectTrigger>
										<SelectContent>
											{options.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{option.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</FormRow>
							)}
						/>
						<Controller
							control={form.control}
							name="reason"
							render={({ field, fieldState }) => (
								<FormRow
									label="Reason"
									htmlFor={`${ids}-reason`}
									invalid={fieldState.invalid}
									error={fieldState.error}
								>
									<Textarea
										{...field}
										id={`${ids}-reason`}
										aria-invalid={fieldState.invalid}
										rows={3}
										className="max-h-48 resize-none"
										disabled={isSubmitting}
									/>
								</FormRow>
							)}
						/>
					</FormRows>
					<ActionDialogFooter>
						<CancelButton onClick={() => onOpenChange(false)} disabled={isSubmitting} />
						<SubmitButton pending={isSubmitting} pendingLabel="Saving…">
							{mode === "move_back"
								? target
									? `Move back to ${LIFECYCLE_STAGE_LABELS[target as LifecycleStage]}`
									: "Move back"
								: "Set disposition"}
						</SubmitButton>
					</ActionDialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
