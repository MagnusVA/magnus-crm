"use client";

import { useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation } from "convex/react";
import posthog from "posthog-js";
import { Controller, useForm, useWatch } from "react-hook-form";
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
import { Card } from "@/components/ui/card";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import { PageBand } from "@/app/workspace/_components/page-band";
import { CloserSelect } from "./closer-select";
import {
	createOpportunitySchema,
	type CreateOpportunityFormValues,
	type SocialPlatform,
} from "./create-opportunity-schema";
import { LeadCombobox } from "./lead-combobox";

const LIST_HREF = "/workspace/leads-customers";

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

/**
 * A ruled form row: a 13px slate label in a 7.5rem column beside the
 * control, the person card's dense rows grown to a control's height. In a
 * narrow container the label sits over the control.
 */
const ROW =
	"grid gap-1.5 px-4 py-3 data-[invalid=true]:text-foreground @lg:grid-cols-[7.5rem_minmax(0,1fr)] @lg:items-start @lg:gap-x-3";
const ROW_LABEL =
	"text-[13px] font-normal text-muted-foreground @lg:min-h-8 @lg:items-center";
/** One side of the segmented toggle; the chosen side lifts (DESIGN.md, Segment lift). */
const SEGMENT =
	"h-6 rounded-[5px]! px-2.5 text-[13px] text-muted-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(20_26_40/0.12)]";
/** A row whose section title already names it: the control takes the width. */
const FULL_ROW = "gap-1.5 px-4 py-3 data-[invalid=true]:text-foreground";
/** Field errors in danger ink, which reads at 4.5:1 where the fill red doesn't. */
const ERROR = "text-[13px] text-danger-ink";

function normalizeOptional(value?: string) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function extractSubmitErrorMessage(error: unknown) {
	const fallback = "The deal wasn't created. Try again.";
	const message = getErrorMessage(error, fallback).trim();
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

/**
 * New side deal: a deal logged outside Calendly, for an existing person or a
 * new one. On success it opens the person page with the new deal's modal.
 */
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
	const ids = useId();
	const personTitleId = `${ids}-person`;

	usePageTitle("New side deal");

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

	const leadMode = useWatch({ control: form.control, name: "leadMode" });

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
								email: normalizeOptional(values.newEmail)?.toLowerCase(),
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
			toast.success("Side deal created");
			requestIdRef.current = crypto.randomUUID();
			router.push(
				`/workspace/leads-customers/${result.leadId}?opportunityId=${result.opportunityId}`,
			);
		} catch (error) {
			reportClientError(error, { flow: "opportunity_create" });
			const message = extractSubmitErrorMessage(error);
			setSubmitError(message);
			isSubmittingRef.current = false;
			setIsSubmitting(false);
		}
	};

	return (
		<div className="@container mx-auto flex w-full max-w-[640px] flex-col gap-3.5 pb-6 short:gap-3">
			<PageBand
				title="New side deal"
				description="A deal logged outside Calendly. Record its payment from the deal once it's created."
				back={{ href: LIST_HREF, label: "Leads & Customers" }}
			/>

			<form
				onSubmit={(event) => void form.handleSubmit(onSubmit)(event)}
				noValidate
				className="w-full"
			>
				<Card className="gap-0 py-0">
					<section aria-labelledby={personTitleId}>
						<SectionTitle id={personTitleId} title="Person">
							<Controller
								control={form.control}
								name="leadMode"
								render={({ field }) => (
									<ToggleGroup
										type="single"
										value={field.value}
										onValueChange={(value) => {
											// A segmented toggle always keeps one side on.
											if (value !== "existing" && value !== "new") return;
											field.onChange(value);
											setSubmitError(null);
										}}
										disabled={isSubmitting}
										aria-label="Existing or new person"
										className="ml-auto rounded-[7px] border bg-background p-0.5"
									>
										<ToggleGroupItem
											value="existing"
											className={SEGMENT}
										>
											Existing
										</ToggleGroupItem>
										<ToggleGroupItem
											value="new"
											className={SEGMENT}
										>
											New
										</ToggleGroupItem>
									</ToggleGroup>
								)}
							/>
						</SectionTitle>

						{leadMode === "existing" ? (
							<Controller
								control={form.control}
								name="existingLeadId"
								render={({ field, fieldState }) => (
									<Field data-invalid={fieldState.invalid} className={FULL_ROW}>
										<FieldLabel htmlFor={`${ids}-person-search`} className="sr-only">
											Person
										</FieldLabel>
										<LeadCombobox
											id={`${ids}-person-search`}
											invalid={fieldState.invalid}
											value={field.value as Id<"leads"> | undefined}
											onChange={(value) => {
												field.onChange(value);
												setSubmitError(null);
											}}
											disabled={isSubmitting}
										/>
										<FieldDescription className="text-[13px]">
											Type two or more letters of a name, an email or a phone.
										</FieldDescription>
										<FieldError className={ERROR} errors={[fieldState.error]} />
									</Field>
								)}
							/>
						) : (
							<FieldGroup className="gap-0 divide-y">
								<Controller
									control={form.control}
									name="newFullName"
									render={({ field, fieldState }) => (
										<Field data-invalid={fieldState.invalid} className={ROW}>
											<FieldLabel htmlFor={`${ids}-name`} className={ROW_LABEL}>
												Name
											</FieldLabel>
											<RowControl>
												<Input
													{...field}
													id={`${ids}-name`}
													autoComplete="name"
													placeholder="Jane Smith"
													aria-required
													aria-invalid={fieldState.invalid}
													disabled={isSubmitting}
												/>
												<FieldError className={ERROR} errors={[fieldState.error]} />
											</RowControl>
										</Field>
									)}
								/>
								<Controller
									control={form.control}
									name="newEmail"
									render={({ field, fieldState }) => (
										<Field data-invalid={fieldState.invalid} className={ROW}>
											<FieldLabel htmlFor={`${ids}-email`} className={ROW_LABEL}>
												Email
											</FieldLabel>
											<RowControl>
												<Input
													{...field}
													id={`${ids}-email`}
													type="email"
													autoComplete="email"
													spellCheck={false}
													placeholder="jane@example.com"
													aria-invalid={fieldState.invalid}
													disabled={isSubmitting}
												/>
												<FieldError className={ERROR} errors={[fieldState.error]} />
											</RowControl>
										</Field>
									)}
								/>
								<Controller
									control={form.control}
									name="newPhone"
									render={({ field, fieldState }) => (
										<Field data-invalid={fieldState.invalid} className={ROW}>
											<FieldLabel htmlFor={`${ids}-phone`} className={ROW_LABEL}>
												Phone
											</FieldLabel>
											<RowControl>
												<Input
													{...field}
													id={`${ids}-phone`}
													type="tel"
													autoComplete="tel"
													placeholder="+1 555 0100"
													aria-invalid={fieldState.invalid}
													disabled={isSubmitting}
													className="font-condensed text-[15px] tracking-[0.02em] tabular-nums md:text-[15px]"
												/>
												<FieldError className={ERROR} errors={[fieldState.error]} />
											</RowControl>
										</Field>
									)}
								/>
								<SocialRow
									ids={ids}
									control={form.control}
									disabled={isSubmitting}
									onPlatformChange={() => setSubmitError(null)}
								/>
								<p className="px-4 py-2.5 text-[13px] text-muted-foreground">
									Give a name and at least one way to reach the person: an
									email, a phone or a social handle.
								</p>
							</FieldGroup>
						)}
					</section>

					{isAdmin ? (
						<section aria-labelledby={`${ids}-closer-title`} className="border-t">
							<SectionTitle id={`${ids}-closer-title`} title="Closer" />
							<Controller
								control={form.control}
								name="assignedCloserId"
								render={({ field, fieldState }) => (
									<Field data-invalid={fieldState.invalid} className={FULL_ROW}>
										<FieldLabel htmlFor={`${ids}-closer`} className="sr-only">
											Closer
										</FieldLabel>
										<CloserSelect
											id={`${ids}-closer`}
											invalid={fieldState.invalid}
											value={field.value as Id<"users"> | undefined}
											onChange={(value) => {
												field.onChange(value);
												setSubmitError(null);
											}}
											disabled={isSubmitting}
										/>
										<FieldDescription className="text-[13px]">
											The deal and its payment are credited to this closer.
										</FieldDescription>
										<FieldError className={ERROR} errors={[fieldState.error]} />
									</Field>
								)}
							/>
						</section>
					) : null}

					<section aria-labelledby={`${ids}-notes-title`} className="border-t">
						<SectionTitle id={`${ids}-notes-title`} title="Notes">
							<span className="ml-auto text-[13px] text-muted-foreground">
								Optional
							</span>
						</SectionTitle>
						<Controller
							control={form.control}
							name="notes"
							render={({ field, fieldState }) => (
								<Field data-invalid={fieldState.invalid} className={FULL_ROW}>
									<FieldLabel htmlFor={`${ids}-notes`} className="sr-only">
										Notes
									</FieldLabel>
									<Textarea
										{...field}
										id={`${ids}-notes`}
										rows={4}
										placeholder="How did this deal come about?"
										aria-invalid={fieldState.invalid}
										disabled={isSubmitting}
									/>
									<FieldError className={ERROR} errors={[fieldState.error]} />
								</Field>
							)}
						/>
					</section>

					<div className="flex flex-wrap items-center justify-end gap-2 border-t bg-background px-4 py-3">
						<Button
							asChild
							variant="outline"
							className={cn(isSubmitting && "pointer-events-none opacity-50")}
						>
							<Link href={LIST_HREF} aria-disabled={isSubmitting || undefined}>
								Cancel
							</Link>
						</Button>
						<Button type="submit" disabled={isSubmitting} className="font-semibold">
							{isSubmitting ? <Spinner data-icon="inline-start" /> : null}
							{isSubmitting ? "Creating…" : "Create side deal"}
						</Button>
					</div>
				</Card>
			</form>

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
						<AlertDialogTitle>Couldn&apos;t create the side deal</AlertDialogTitle>
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

/** A section's 44px title row, with room on the right for a control or meta. */
function SectionTitle({
	id,
	title,
	children,
}: {
	id: string;
	title: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex min-h-11 items-center gap-2 border-b px-4 py-2">
			<h2 id={id} className="text-[15px] font-semibold">
				{title}
			</h2>
			{children}
		</div>
	);
}

function RowControl({ children }: { children: React.ReactNode }) {
	return <div className="flex min-w-0 flex-col gap-1.5">{children}</div>;
}

/** Platform and handle on one row: they're given together or not at all. */
function SocialRow({
	ids,
	control,
	disabled,
	onPlatformChange,
}: {
	ids: string;
	control: ReturnType<typeof useForm<CreateOpportunityFormValues>>["control"];
	disabled: boolean;
	onPlatformChange: () => void;
}) {
	return (
		<Controller
			control={control}
			name="newSocialPlatform"
			render={({ field: platform, fieldState: platformState }) => (
				<Controller
					control={control}
					name="newSocialHandle"
					render={({ field: handle, fieldState: handleState }) => (
						<Field
							data-invalid={platformState.invalid || handleState.invalid}
							className={ROW}
						>
							<FieldLabel htmlFor={`${ids}-platform`} className={ROW_LABEL}>
								Social
							</FieldLabel>
							<RowControl>
								<div className="flex min-w-0 flex-wrap gap-2">
									<Select
										value={platform.value ?? ""}
										onValueChange={(value) => {
											platform.onChange(value);
											onPlatformChange();
										}}
										disabled={disabled}
									>
										<SelectTrigger
											id={`${ids}-platform`}
											aria-label="Social platform"
											aria-invalid={platformState.invalid}
											className="w-[9.5rem]"
										>
											<SelectValue placeholder="Platform" />
										</SelectTrigger>
										<SelectContent>
											<SelectGroup>
												{SOCIAL_PLATFORM_OPTIONS.map((option) => (
													<SelectItem key={option.value} value={option.value}>
														{option.label}
													</SelectItem>
												))}
											</SelectGroup>
										</SelectContent>
									</Select>
									<Input
										{...handle}
										aria-label="Social handle"
										autoComplete="off"
										spellCheck={false}
										placeholder="@janesmith"
										aria-invalid={handleState.invalid}
										disabled={disabled}
										className="min-w-40 flex-1"
									/>
									{platform.value ? (
										<Button
											type="button"
											variant="ghost"
											disabled={disabled}
											onClick={() => platform.onChange(undefined)}
											className="text-muted-foreground"
										>
											Clear
										</Button>
									) : null}
								</div>
								<FieldError className={ERROR} errors={[platformState.error, handleState.error]} />
							</RowControl>
						</Field>
					)}
				/>
			)}
		/>
	);
}
