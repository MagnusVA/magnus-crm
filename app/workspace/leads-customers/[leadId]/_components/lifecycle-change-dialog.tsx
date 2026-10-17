"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { toast } from "sonner";
import { AlertCircleIcon } from "lucide-react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
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
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";

const changeSchema = z.object({
	target: z.string().min(1, "Pick one"),
	reason: z
		.string()
		.trim()
		.min(1, "Say why")
		.max(500, "Keep the reason to 500 characters"),
});

export type LifecycleChangeMode = "move_back" | "disposition";

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
	const [submitError, setSubmitError] = useState<string | null>(null);
	const moveBack = useMutation(api.leads.lifecycleAdmin.moveLifecycleStageBack);
	const setDisposition = useMutation(api.leads.lifecycleAdmin.setDisposition);
	const form = useForm({
		resolver: standardSchemaResolver(changeSchema),
		defaultValues: { target: "", reason: "" },
	});
	const isSubmitting = form.formState.isSubmitting;

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
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{mode === "move_back" ? "Move stage back" : "Set disposition"}</DialogTitle>
					<DialogDescription>
						{mode === "move_back"
							? "Use this to correct a stage the records got wrong. The later stages stop counting until the person reaches them again."
							: "Whether the team should keep working this person. Only an admin can change it after this."}
					</DialogDescription>
				</DialogHeader>

				{submitError ? (
					<Alert variant="destructive">
						<AlertCircleIcon className="size-4" />
						<AlertDescription>{submitError}</AlertDescription>
					</Alert>
				) : null}

				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6">
						<FormField
							control={form.control}
							name="target"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{mode === "move_back" ? "New stage" : "Disposition"}</FormLabel>
									<Select value={field.value} onValueChange={field.onChange} disabled={isSubmitting}>
										<FormControl>
											<SelectTrigger className="w-full">
												<SelectValue placeholder="Choose…" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{options.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{option.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="reason"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Reason</FormLabel>
									<FormControl>
										<Textarea rows={3} disabled={isSubmitting} {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<DialogFooter>
							<Button type="button" variant="outline" disabled={isSubmitting} onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={isSubmitting}>
								{isSubmitting ? <Spinner /> : null}
								Save
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
}
