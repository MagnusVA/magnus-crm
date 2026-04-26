"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation } from "convex/react";
import { ChevronLeftIcon } from "lucide-react";
import posthog from "posthog-js";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useRole } from "@/components/auth/role-context";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { CloserSelect } from "./closer-select";
import {
	createOpportunitySchema,
	type CreateOpportunityFormValues,
	type SocialPlatform,
} from "./create-opportunity-schema";
import { LeadCombobox } from "./lead-combobox";

const SOCIAL_PLATFORM_OPTIONS: Array<{
	value: SocialPlatform;
	label: string;
}> = [
	{ value: "instagram", label: "Instagram" },
	{ value: "tiktok", label: "TikTok" },
	{ value: "twitter", label: "Twitter/X" },
	{ value: "facebook", label: "Facebook" },
	{ value: "linkedin", label: "LinkedIn" },
	{ value: "other_social", label: "Other" },
];

function normalizeOptional(value?: string) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function extractSubmitErrorMessage(error: unknown) {
	const fallback = "Failed to create opportunity";
	if (!(error instanceof Error)) {
		return fallback;
	}

	const message = error.message.trim();
	if (!message) {
		return fallback;
	}

	const uncaughtMarker = "Uncaught Error:";
	const markerIndex = message.indexOf(uncaughtMarker);
	let sanitized =
		markerIndex === -1
			? message
			: message.slice(markerIndex + uncaughtMarker.length).trim();

	const stackStartIndex = sanitized.search(/\s+at\s+[\w$.<>]+\s+\(/);
	if (stackStartIndex !== -1) {
		sanitized = sanitized.slice(0, stackStartIndex).trim();
	}

	sanitized = sanitized.replace(/\s+Called by client\s*$/, "").trim();

	return sanitized || fallback;
}

export function CreateOpportunityPageClient() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const { isAdmin } = useRole();
	const createManual = useMutation(
		api.opportunities.createManual.createManual,
	);
	const requestIdRef = useRef<string | null>(null);
	const isSubmittingRef = useRef(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const prefilledLeadId = searchParams.get("leadId") as Id<"leads"> | null;

	usePageTitle("New Opportunity");

	const schema = useMemo(
		() => createOpportunitySchema({ requireAssignedCloser: isAdmin }),
		[isAdmin],
	);

	const form = useForm({
		resolver: standardSchemaResolver(schema),
		defaultValues: {
			leadMode: "existing",
			existingLeadId: prefilledLeadId ?? undefined,
			newFullName: "",
			newEmail: "",
			newPhone: "",
			newSocialPlatform: undefined,
			newSocialHandle: "",
			assignedCloserId: undefined,
			notes: "",
		},
	});

	const leadMode = form.watch("leadMode");

	const onSubmit = async (values: CreateOpportunityFormValues) => {
		if (isSubmittingRef.current) {
			return;
		}

		isSubmittingRef.current = true;
		setIsSubmitting(true);
		setSubmitError(null);
		requestIdRef.current ??= crypto.randomUUID();

		try {
			const result = await createManual({
				clientRequestId: requestIdRef.current,
				existingLeadId:
					values.leadMode === "existing"
						? (values.existingLeadId as Id<"leads">)
						: undefined,
				newLeadInput:
					values.leadMode === "new"
						? {
								fullName: values.newFullName!.trim(),
								email: values.newEmail!.trim().toLowerCase(),
								phone: normalizeOptional(values.newPhone),
								socialHandle:
									values.newSocialPlatform && values.newSocialHandle?.trim()
										? {
												platform: values.newSocialPlatform,
												handle: values.newSocialHandle.trim(),
											}
										: undefined,
							}
						: undefined,
				assignedCloserId: values.assignedCloserId
					? (values.assignedCloserId as Id<"users">)
					: undefined,
				notes: normalizeOptional(values.notes),
			});

			posthog.capture("opportunity_created_manual", {
				opportunity_id: result.opportunityId,
				lead_id: result.leadId,
				lead_was_created: result.leadWasCreated,
				created_by_admin: isAdmin,
				assigned_closer_id: values.assignedCloserId ?? null,
			});
			toast.success("Opportunity created");
			requestIdRef.current = crypto.randomUUID();
			router.push(`/workspace/opportunities/${result.opportunityId}`);
		} catch (error) {
			posthog.captureException(error);
			const message = extractSubmitErrorMessage(error);
			setSubmitError(message);
			isSubmittingRef.current = false;
			setIsSubmitting(false);
		}
	};

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
			<div className="flex flex-col gap-2">
				<div>
					<Button asChild variant="ghost" size="sm" className="-ml-2">
						<Link href="/workspace/opportunities">
							<ChevronLeftIcon data-icon="inline-start" />
							Back to opportunities
						</Link>
					</Button>
				</div>
				<div className="flex flex-col gap-1">
					<h1 className="text-2xl font-semibold tracking-tight">
						New opportunity
					</h1>
					<p className="text-sm text-muted-foreground">
						Create a side-deal opportunity, then record payment from its
						detail page.
					</p>
				</div>
			</div>

			<Form {...form}>
				<form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6">
					<Card>
						<CardHeader>
							<CardTitle className="text-base">Lead</CardTitle>
							<CardDescription>
								Pick an existing lead or create a new MVP lead.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<FieldGroup>
								<FormField
									control={form.control}
									name="leadMode"
									render={({ field }) => (
										<FormItem>
											<FormControl>
												<RadioGroup
													value={field.value}
													onValueChange={(value) => {
														field.onChange(value);
														setSubmitError(null);
													}}
													className="grid grid-cols-1 gap-2 sm:grid-cols-2"
													disabled={isSubmitting}
												>
													<label className="flex min-h-16 cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5">
														<RadioGroupItem value="existing" />
														<span className="flex min-w-0 flex-col gap-1">
															<span className="font-medium">Existing lead</span>
															<span className="text-muted-foreground">
																Search your tenant leads.
															</span>
														</span>
													</label>
													<label className="flex min-h-16 cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5">
														<RadioGroupItem value="new" />
														<span className="flex min-w-0 flex-col gap-1">
															<span className="font-medium">New lead</span>
															<span className="text-muted-foreground">
																Create a minimal record.
															</span>
														</span>
													</label>
												</RadioGroup>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>

								{leadMode === "existing" ? (
									<FormField
										control={form.control}
										name="existingLeadId"
										render={({ field }) => (
											<FormItem>
												<FormLabel>
													Lead <span className="text-destructive">*</span>
												</FormLabel>
												<FormControl>
													<LeadCombobox
														value={field.value as Id<"leads"> | undefined}
														onChange={(value) => {
															field.onChange(value);
															setSubmitError(null);
														}}
														disabled={isSubmitting}
													/>
												</FormControl>
												<FormDescription>
													Search starts after two characters.
												</FormDescription>
												<FormMessage />
											</FormItem>
										)}
									/>
								) : (
									<div className="flex flex-col gap-5">
										<div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
											<FormField
												control={form.control}
												name="newFullName"
												render={({ field }) => (
													<FormItem>
														<FormLabel>
															Full name{" "}
															<span className="text-destructive">*</span>
														</FormLabel>
														<FormControl>
															<Input
																autoComplete="name"
																placeholder="Jane Smith"
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
												name="newEmail"
												render={({ field }) => (
													<FormItem>
														<FormLabel>
															Email <span className="text-destructive">*</span>
														</FormLabel>
														<FormControl>
															<Input
																type="email"
																autoComplete="email"
																spellCheck={false}
																placeholder="jane@example.com"
																disabled={isSubmitting}
																{...field}
															/>
														</FormControl>
														<FormMessage />
													</FormItem>
												)}
											/>
										</div>
										<div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
											<FormField
												control={form.control}
												name="newPhone"
												render={({ field }) => (
													<FormItem>
														<FormLabel>Phone</FormLabel>
														<FormControl>
															<Input
																type="tel"
																autoComplete="tel"
																placeholder="+1 555 0100"
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
												name="newSocialPlatform"
												render={({ field }) => (
													<FormItem>
														<FormLabel>Social platform</FormLabel>
														<div className="flex flex-col gap-2 sm:flex-row">
															<Select
																value={field.value}
																onValueChange={(value) => {
																	field.onChange(value);
																	setSubmitError(null);
																}}
																disabled={isSubmitting}
															>
																<FormControl>
																	<SelectTrigger className="w-full">
																		<SelectValue placeholder="Select platform" />
																	</SelectTrigger>
																</FormControl>
																<SelectContent>
																	<SelectGroup>
																		{SOCIAL_PLATFORM_OPTIONS.map((option) => (
																			<SelectItem
																				key={option.value}
																				value={option.value}
																			>
																				{option.label}
																			</SelectItem>
																		))}
																	</SelectGroup>
																</SelectContent>
															</Select>
															{field.value ? (
																<Button
																	type="button"
																	variant="outline"
																	disabled={isSubmitting}
																	onClick={() => field.onChange(undefined)}
																	className="sm:w-auto"
																>
																	Clear
																</Button>
															) : null}
														</div>
														<FormMessage />
													</FormItem>
												)}
											/>
										</div>
										<FormField
											control={form.control}
											name="newSocialHandle"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Social handle</FormLabel>
													<FormControl>
														<Input
															autoComplete="off"
															spellCheck={false}
															placeholder="@janesmith"
															disabled={isSubmitting}
															{...field}
														/>
													</FormControl>
													<FormDescription>
														Platform and handle must be provided together.
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
									</div>
								)}
							</FieldGroup>
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle className="text-base">Opportunity</CardTitle>
							<CardDescription>
								{isAdmin
									? "Assign this side deal to an active closer."
									: "Add context for the deal."}
							</CardDescription>
						</CardHeader>
						<CardContent>
							<FieldGroup>
								{isAdmin ? (
									<FormField
										control={form.control}
										name="assignedCloserId"
										render={({ field }) => (
											<FormItem>
												<FormLabel>
													Closer <span className="text-destructive">*</span>
												</FormLabel>
												<FormControl>
													<CloserSelect
														value={field.value as Id<"users"> | undefined}
														onChange={(value) => {
															field.onChange(value);
															setSubmitError(null);
														}}
														disabled={isSubmitting}
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
								) : null}
								<FormField
									control={form.control}
									name="notes"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Notes</FormLabel>
											<FormControl>
												<Textarea
													rows={4}
													placeholder="How did this opportunity come about?"
													disabled={isSubmitting}
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							</FieldGroup>
						</CardContent>
					</Card>

					<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<Button asChild variant="outline" type="button" disabled={isSubmitting}>
							<Link href="/workspace/opportunities">Cancel</Link>
						</Button>
						<Button type="submit" disabled={isSubmitting}>
							{isSubmitting ? <Spinner data-icon="inline-start" /> : null}
							{isSubmitting ? "Creating…" : "Create opportunity"}
						</Button>
					</div>
				</form>
			</Form>

			<AlertDialog
				open={submitError !== null}
				onOpenChange={(open) => {
					if (!open) {
						setSubmitError(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Could not create opportunity</AlertDialogTitle>
						<AlertDialogDescription>{submitError}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogAction>OK</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
