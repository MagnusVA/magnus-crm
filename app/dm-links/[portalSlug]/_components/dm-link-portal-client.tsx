"use client";

import {
	type ReactNode,
	useActionState,
	useEffect,
	useMemo,
	useState,
} from "react";
import posthog from "posthog-js";
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	AlertCircleIcon,
	CalendarIcon,
	CheckCircle2Icon,
	CheckIcon,
	CopyIcon,
	LinkIcon,
	LogOutIcon,
	RefreshCwIcon,
	TagIcon,
	TimerIcon,
	UserIcon,
} from "lucide-react";
import type {
	PortalCopyInput,
	PortalCopyResult,
	PortalUnlockState,
} from "../actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";
import { isPostHogEnabled } from "@/lib/posthog-config";
import { cn } from "@/lib/utils";
import {
	formatEventTypeSummary,
	groupBookablePrograms,
	type BookableProgramEventType,
} from "./group-bookable-programs";
import { prepareProgramLinks } from "./prepare-program-links";

const initialUnlockState: PortalUnlockState = { status: "idle" };
const LINK_EXPIRATION_MS = 60_000;
const LINK_EXPIRATION_SECONDS = LINK_EXPIRATION_MS / 1000;

const portalSteps = [
	{ id: "closer", label: "Closer", icon: UserIcon },
	{ id: "program", label: "Program", icon: CalendarIcon },
	{ id: "campaign", label: "Campaign", icon: TagIcon },
	{ id: "generate", label: "Generate", icon: LinkIcon },
] as const;

type PortalStep = (typeof portalSteps)[number]["id"];

type ActiveGeneratedLink = {
	url: string;
	generatedAt: number;
	expiresAt: number;
	eventTypeConfigId: string;
	eventTypeDisplayName: string;
	bookingProgramId: string;
	dmCloserId: string;
	teamId: string;
	campaignPresetId: string;
	campaign: string;
};

type GeneratedLinkBatch = {
	generatedAt: number;
	expiresAt: number;
	links: ActiveGeneratedLink[];
};

type LinkCopyState = "idle" | "copying" | "copied" | "manual";

type PortalBootstrap = {
	tenantName: string;
	campaignPresets: Array<{
		id: string;
		label: string;
		utmCampaign: string;
		isDefault: boolean;
	}>;
	dmClosers: Array<{
		id: string;
		displayName: string;
		utmMedium: string;
		teamId: string;
		teamDisplayName: string;
		teamUtmSource: string;
	}>;
	bookablePrograms: Array<BookableProgramEventType>;
};

type DmLinkPortalClientProps = {
	portalSlug: string;
	bootstrap: PortalBootstrap | null;
	unlockPortal: (
		portalSlug: string,
		prevState: PortalUnlockState,
		formData: FormData,
	) => Promise<PortalUnlockState>;
	logoutPortal: (portalSlug: string, formData: FormData) => Promise<void>;
	recordPortalCopy: (
		portalSlug: string,
		input: PortalCopyInput,
	) => Promise<PortalCopyResult>;
};

function PasswordScreen({
	portalSlug,
	unlockPortal,
}: {
	portalSlug: string;
	unlockPortal: DmLinkPortalClientProps["unlockPortal"];
}) {
	const [state, formAction, isPending] = useActionState(
		unlockPortal.bind(null, portalSlug),
		initialUnlockState,
	);
	const passwordErrorId = "portal-password-error";

	return (
		<main className="mx-auto flex min-h-dvh w-full max-w-md items-center p-4">
			<Card className="w-full">
				<CardHeader>
					<CardTitle>DM Link Portal</CardTitle>
					<CardDescription>
						Enter the portal password shared by your workspace admin.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form action={formAction}>
						<input
							type="text"
							name="username"
							autoComplete="username"
							value={portalSlug}
							readOnly
							hidden
						/>
						<FieldGroup>
							<Field data-invalid={state.status === "error"}>
								<FieldLabel htmlFor="portal-password">Portal Password</FieldLabel>
								<Input
									id="portal-password"
									name="password"
									type="password"
									autoComplete="current-password"
									required
									placeholder="Portal password…"
									aria-invalid={state.status === "error"}
									aria-describedby={
										state.status === "error" ? passwordErrorId : undefined
									}
									disabled={isPending}
								/>
								{state.status === "error" ? (
									<FieldDescription
										id={passwordErrorId}
										aria-live="polite"
										className="text-destructive"
									>
										{state.message}
									</FieldDescription>
								) : null}
							</Field>
							<Button type="submit" className="w-full" disabled={isPending}>
								{isPending ? (
									<>
										<Spinner data-icon="inline-start" />
										Unlocking…
									</>
								) : (
									"Unlock Portal"
								)}
							</Button>
						</FieldGroup>
					</form>
				</CardContent>
			</Card>
		</main>
	);
}

export function DmLinkPortalClient({
	portalSlug,
	bootstrap,
	unlockPortal,
	logoutPortal,
	recordPortalCopy,
}: DmLinkPortalClientProps) {
	if (!bootstrap) {
		return (
			<PasswordScreen portalSlug={portalSlug} unlockPortal={unlockPortal} />
		);
	}

	return (
		<UnlockedPortal
			portalSlug={portalSlug}
			bootstrap={bootstrap}
			logoutPortal={logoutPortal}
			recordPortalCopy={recordPortalCopy}
		/>
	);
}

function SelectableOption({
	selected,
	title,
	description,
	meta,
	icon,
	onClick,
	disabled,
}: {
	selected: boolean;
	title: string;
	description?: string;
	meta?: ReactNode;
	icon: ReactNode;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"flex min-h-24 min-w-0 flex-col rounded-lg border p-3 text-left transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
				selected
					? "border-primary bg-primary/5 ring-1 ring-primary/25"
					: "border-border bg-background hover:bg-muted/60",
			)}
		>
			<span className="flex min-w-0 items-start gap-3">
				<span
					className={cn(
						"mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md",
						selected
							? "bg-primary text-primary-foreground"
							: "bg-muted text-muted-foreground",
					)}
				>
					{selected ? <CheckIcon aria-hidden="true" /> : icon}
				</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate font-medium">{title}</span>
					{description ? (
						<span className="mt-1 block text-sm leading-snug text-muted-foreground">
							{description}
						</span>
					) : null}
				</span>
			</span>
			{meta ? <span className="mt-3 flex flex-wrap gap-2">{meta}</span> : null}
		</button>
	);
}

function UnlockedPortal({
	portalSlug,
	bootstrap,
	logoutPortal,
	recordPortalCopy,
}: {
	portalSlug: string;
	bootstrap: PortalBootstrap;
	logoutPortal: DmLinkPortalClientProps["logoutPortal"];
	recordPortalCopy: DmLinkPortalClientProps["recordPortalCopy"];
}) {
	const [selectedCloserId, setSelectedCloserId] = useState("");
	const [selectedProgramId, setSelectedProgramId] = useState("");
	const [selectedCampaignId, setSelectedCampaignId] = useState("");
	const [currentStep, setCurrentStep] = useState<PortalStep>("closer");
	const [generatedBatch, setGeneratedBatch] =
		useState<GeneratedLinkBatch | null>(null);
	const [now, setNow] = useState(0);
	const [copyStates, setCopyStates] = useState<
		Record<string, LinkCopyState>
	>({});

	const groupedPrograms = useMemo(
		() => groupBookablePrograms(bootstrap.bookablePrograms),
		[bootstrap.bookablePrograms],
	);

	const closer = bootstrap.dmClosers.find((row) => row.id === selectedCloserId);
	const program = groupedPrograms.find(
		(row) => row.bookingProgramId === selectedProgramId,
	);
	const campaign = bootstrap.campaignPresets.find(
		(row) => row.id === selectedCampaignId,
	);

	const preparedLinks = useMemo(() => {
		if (!closer || !program || !campaign) {
			return { status: "empty" as const, links: [] };
		}

		return prepareProgramLinks({
			closer,
			campaign,
			eventTypes: program.eventTypes,
		});
	}, [campaign, closer, program]);

	const invalidEventTypes = useMemo(
		() =>
			preparedLinks.links.filter((link) => link.status === "invalid_base_url"),
		[preparedLinks.links],
	);

	const setupIncomplete =
		bootstrap.dmClosers.length === 0 ||
		groupedPrograms.length === 0 ||
		bootstrap.campaignPresets.length === 0;
	const currentStepIndex = portalSteps.findIndex(
		(step) => step.id === currentStep,
	);
	const completedStepCount = [
		Boolean(closer),
		Boolean(program),
		Boolean(campaign),
		Boolean(generatedBatch),
	].filter(Boolean).length;
	const progressValue = (completedStepCount / portalSteps.length) * 100;
	const remainingMs = generatedBatch
		? Math.max(0, generatedBatch.expiresAt - now)
		: 0;
	const remainingSeconds = generatedBatch
		? Math.max(0, Math.ceil(remainingMs / 1000))
		: LINK_EXPIRATION_SECONDS;
	const timerProgress = generatedBatch
		? (remainingMs / LINK_EXPIRATION_MS) * 100
		: 0;
	const canGenerate =
		!setupIncomplete &&
		preparedLinks.status === "ready" &&
		preparedLinks.readyLinks.length > 0;

	useEffect(() => {
		if (!generatedBatch) {
			return;
		}

		const expirationDelay = Math.max(0, generatedBatch.expiresAt - Date.now());
		const intervalId = window.setInterval(() => {
			setNow(Date.now());
		}, 1000);
		const timeoutId = window.setTimeout(() => {
			resetPortalState();
		}, expirationDelay);

		return () => {
			window.clearInterval(intervalId);
			window.clearTimeout(timeoutId);
		};
	}, [generatedBatch]);

	function resetPortalState() {
		setSelectedCloserId("");
		setSelectedProgramId("");
		setSelectedCampaignId("");
		setCurrentStep("closer");
		setGeneratedBatch(null);
		setCopyStates({});
		setNow(0);
	}

	function resetGeneratedLinks() {
		setGeneratedBatch(null);
		setCopyStates({});
		setNow(0);
	}

	function selectCloser(value: string) {
		if (value !== selectedCloserId) {
			resetGeneratedLinks();
		}
		setSelectedCloserId(value);
	}

	function selectProgram(value: string) {
		if (value !== selectedProgramId) {
			resetGeneratedLinks();
		}
		setSelectedProgramId(value);
	}

	function selectCampaign(value: string) {
		if (value !== selectedCampaignId) {
			resetGeneratedLinks();
		}
		setSelectedCampaignId(value);
	}

	function isStepComplete(step: PortalStep) {
		if (step === "closer") {
			return Boolean(closer);
		}
		if (step === "program") {
			return Boolean(program);
		}
		if (step === "campaign") {
			return Boolean(campaign);
		}
		return Boolean(generatedBatch);
	}

	function canOpenStep(step: PortalStep) {
		if (step === "closer") {
			return true;
		}
		if (step === "program") {
			return Boolean(closer);
		}
		if (step === "campaign") {
			return Boolean(closer && program);
		}
		return Boolean(closer && program && campaign);
	}

	function goToStep(step: PortalStep) {
		if (canOpenStep(step)) {
			setCurrentStep(step);
		}
	}

	function goNext() {
		const nextStep = portalSteps[currentStepIndex + 1]?.id;
		if (nextStep && canOpenStep(nextStep)) {
			setCurrentStep(nextStep);
		}
	}

	function goBack() {
		const previousStep = portalSteps[currentStepIndex - 1]?.id;
		if (previousStep) {
			setCurrentStep(previousStep);
		}
	}

	function generateLinks() {
		if (
			!closer ||
			!program ||
			!campaign ||
			preparedLinks.status !== "ready"
		) {
			return;
		}

		const generatedAt = Date.now();
		setNow(generatedAt);
		setCopyStates({});
		setGeneratedBatch({
			generatedAt,
			expiresAt: generatedAt + LINK_EXPIRATION_MS,
			links: preparedLinks.readyLinks.map((link) => ({
				url: link.url,
				generatedAt,
				expiresAt: generatedAt + LINK_EXPIRATION_MS,
				eventTypeConfigId: link.eventTypeConfigId,
				eventTypeDisplayName: link.eventTypeDisplayName,
				bookingProgramId: link.bookingProgramId,
				dmCloserId: closer.id,
				teamId: closer.teamId,
				campaignPresetId: campaign.id,
				campaign: campaign.utmCampaign,
			})),
		});
	}

	async function copyGeneratedUrl(activeLink: ActiveGeneratedLink) {
		const copyState = copyStates[activeLink.eventTypeConfigId] ?? "idle";
		if (copyState === "copying") {
			return;
		}

		if (!generatedBatch || Date.now() >= generatedBatch.expiresAt) {
			resetPortalState();
			return;
		}

		setCopyStates((current) => ({
			...current,
			[activeLink.eventTypeConfigId]: "copying",
		}));

		try {
			await navigator.clipboard.writeText(activeLink.url);
			setCopyStates((current) => ({
				...current,
				[activeLink.eventTypeConfigId]: "copied",
			}));
		} catch {
			const input = document.getElementById(
				`generated-booking-url-${activeLink.eventTypeConfigId}`,
			);
			if (input instanceof HTMLInputElement) {
				input.focus();
				input.select();
			}
			setCopyStates((current) => ({
				...current,
				[activeLink.eventTypeConfigId]: "manual",
			}));
			return;
		}

		let auditResult: PortalCopyResult = { recorded: false };
		try {
			auditResult = await recordPortalCopy(portalSlug, {
				eventTypeConfigId: activeLink.eventTypeConfigId,
				dmCloserId: activeLink.dmCloserId,
				campaignPresetId: activeLink.campaignPresetId,
			});
		} catch (error) {
			console.warn("[LinkPortal] copy audit action failed", error);
		}

		if (isPostHogEnabled()) {
			posthog.capture("dm_link_copied", {
				event_type_config_id: activeLink.eventTypeConfigId,
				booking_program_id: activeLink.bookingProgramId,
				dm_closer_id: activeLink.dmCloserId,
				team_id: activeLink.teamId,
				campaign_preset_id: activeLink.campaignPresetId,
				campaign: activeLink.campaign,
				copy_audit_attempted: true,
				copy_audit_recorded: auditResult.recorded,
			});
		}
	}

	const stepCopy: Record<
		PortalStep,
		{ title: string; description: string }
	> = {
		closer: {
			title: "Choose the DM closer",
			description: "Pick the person who should receive attribution for this link.",
		},
		program: {
			title: "Choose the program",
			description:
				"Select the booking program. Every portal-ready event type for that program will be generated together.",
		},
		campaign: {
			title: "Choose the campaign",
			description: "Attach the campaign preset that should appear in Calendly UTMs.",
		},
		generate: {
			title: "Generate the links",
			description: `All event types for the selected program appear here for ${LINK_EXPIRATION_SECONDS} seconds. Copy the one you need.`,
		},
	};

	const selectedSummary = [
		{ label: "Closer", value: closer?.displayName ?? "Not selected" },
		{ label: "Program", value: program?.bookingProgramName ?? "Not selected" },
		{ label: "Campaign", value: campaign?.label ?? "Not selected" },
	];

	return (
		<>
			<a
				href="#portal-main"
				className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-3 focus:ring-ring/50"
			>
				Skip to Link Builder
			</a>
			<main
				id="portal-main"
				className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-4 p-4 md:p-8"
			>
				<div className="flex min-w-0 items-center justify-between gap-3">
					<div className="min-w-0">
						<p className="text-sm font-medium text-muted-foreground">
							DM Link Portal
						</p>
						<h1 className="truncate text-2xl font-semibold text-pretty">
							{bootstrap.tenantName}
						</h1>
					</div>
					<form action={logoutPortal.bind(null, portalSlug)}>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="submit"
									variant="ghost"
									size="icon"
									aria-label="Log out of DM link portal"
								>
									<LogOutIcon aria-hidden="true" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>Log Out</TooltipContent>
						</Tooltip>
					</form>
				</div>

				{setupIncomplete ? (
					<Alert>
						<AlertCircleIcon aria-hidden="true" />
						<AlertTitle>Portal Setup Incomplete</AlertTitle>
						<AlertDescription>
							Ask your workspace admin to enable at least 1 active DM closer, 1
							campaign preset, and 1 portal-ready booking link.
						</AlertDescription>
					</Alert>
				) : null}

				{preparedLinks.status === "all_invalid" ? (
					<Alert variant="destructive">
						<AlertCircleIcon aria-hidden="true" />
						<AlertTitle>Booking URLs Need Admin Review</AlertTitle>
						<AlertDescription>
							Every event type for this program has an invalid booking URL. Select
							another program or ask your workspace admin to update them.
						</AlertDescription>
					</Alert>
				) : null}

				{invalidEventTypes.length > 0 && preparedLinks.status === "ready" ? (
					<Alert>
						<AlertCircleIcon aria-hidden="true" />
						<AlertTitle>Some Event Types Are Unavailable</AlertTitle>
						<AlertDescription>
							These event types have invalid booking URLs and will be skipped:{" "}
							{invalidEventTypes
								.map((eventType) => eventType.eventTypeDisplayName)
								.join(", ")}
							.
						</AlertDescription>
					</Alert>
				) : null}

				<Card className="rounded-lg">
					<CardHeader>
						<CardTitle>Booking Link Steps</CardTitle>
						<CardDescription>
							Move through each choice, then generate short-lived Calendly links
							for every event type in the program.
						</CardDescription>
						<CardAction>
							<Badge variant="outline">
								<TimerIcon data-icon="inline-start" aria-hidden="true" />
								{LINK_EXPIRATION_SECONDS}s window
							</Badge>
						</CardAction>
					</CardHeader>
					<CardContent className="flex flex-col gap-5">
						<div className="space-y-3">
							<Progress value={progressValue} aria-label="Link step progress" />
							<nav
								aria-label="Link generation steps"
								className="grid gap-2 sm:grid-cols-4"
							>
								{portalSteps.map((step) => {
									const Icon = step.icon;
									const active = currentStep === step.id;
									const complete = isStepComplete(step.id);

									return (
										<Button
											key={step.id}
											type="button"
											variant={active ? "secondary" : "ghost"}
											size="sm"
											disabled={!canOpenStep(step.id)}
											aria-current={active ? "step" : undefined}
											onClick={() => goToStep(step.id)}
											className="h-auto justify-start gap-2 px-2 py-2"
										>
											<span
												className={cn(
													"flex size-6 shrink-0 items-center justify-center rounded-md",
													complete
														? "bg-primary text-primary-foreground"
														: "bg-muted text-muted-foreground",
												)}
											>
												{complete ? (
													<CheckIcon aria-hidden="true" />
												) : (
													<Icon aria-hidden="true" />
												)}
											</span>
											<span className="truncate">{step.label}</span>
										</Button>
									);
								})}
							</nav>
						</div>

						<div className="space-y-4">
							<div>
								<h2 className="text-lg font-semibold">
									{stepCopy[currentStep].title}
								</h2>
								<p className="mt-1 text-sm text-muted-foreground">
									{stepCopy[currentStep].description}
								</p>
							</div>

							{currentStep === "closer" ? (
								<div className="grid gap-3 md:grid-cols-2">
									{bootstrap.dmClosers.map((row) => (
										<SelectableOption
											key={row.id}
											selected={selectedCloserId === row.id}
											title={row.displayName}
											description={row.teamDisplayName}
											icon={<UserIcon aria-hidden="true" />}
											onClick={() => selectCloser(row.id)}
											disabled={setupIncomplete}
											meta={
												<>
													<Badge
														variant="secondary"
														className="max-w-full justify-start truncate"
														title={`utm_source=${row.teamUtmSource}`}
														translate="no"
													>
														source={row.teamUtmSource}
													</Badge>
													<Badge
														variant="secondary"
														className="max-w-full justify-start truncate"
														title={`utm_medium=${row.utmMedium}`}
														translate="no"
													>
														medium={row.utmMedium}
													</Badge>
												</>
											}
										/>
									))}
								</div>
							) : null}

							{currentStep === "program" ? (
								<div className="grid gap-3 md:grid-cols-2">
									{groupedPrograms.map((row) => (
										<SelectableOption
											key={row.bookingProgramId}
											selected={selectedProgramId === row.bookingProgramId}
											title={row.bookingProgramName}
											description={formatEventTypeSummary(row.eventTypes)}
											icon={<CalendarIcon aria-hidden="true" />}
											onClick={() => selectProgram(row.bookingProgramId)}
											disabled={setupIncomplete}
											meta={
												<Badge variant="outline">
													{row.eventTypes.length}{" "}
													{row.eventTypes.length === 1
														? "event type"
														: "event types"}
												</Badge>
											}
										/>
									))}
								</div>
							) : null}

							{currentStep === "campaign" ? (
								<div className="grid gap-3 md:grid-cols-2">
									{bootstrap.campaignPresets.map((row) => (
										<SelectableOption
											key={row.id}
											selected={selectedCampaignId === row.id}
											title={row.label}
											description={
												row.isDefault ? "Default campaign preset" : undefined
											}
											icon={<TagIcon aria-hidden="true" />}
											onClick={() => selectCampaign(row.id)}
											disabled={setupIncomplete}
											meta={
												<Badge
													variant="secondary"
													className="max-w-full justify-start truncate"
													title={`utm_campaign=${row.utmCampaign}`}
													translate="no"
												>
													campaign={row.utmCampaign}
												</Badge>
											}
										/>
									))}
								</div>
							) : null}

							{currentStep === "generate" ? (
								<div className="space-y-4">
									<div className="grid gap-3 md:grid-cols-3">
										{selectedSummary.map((item) => (
											<div
												key={item.label}
												className="min-w-0 rounded-lg border bg-muted/30 p-3"
											>
												<p className="text-xs font-medium text-muted-foreground">
													{item.label}
												</p>
												<p className="mt-1 truncate font-medium">{item.value}</p>
											</div>
										))}
									</div>

									<div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
										<div className="min-w-0">
											<p className="font-medium">Ready for fresh links</p>
											<p className="text-sm text-muted-foreground">
												Generating starts a {LINK_EXPIRATION_SECONDS}-second copy
												window for{" "}
												{program?.eventTypes.length === 1
													? "1 event type"
													: `${program?.eventTypes.length ?? 0} event types`}
												.
											</p>
										</div>
										<Button
											type="button"
											onClick={generateLinks}
											disabled={!canGenerate}
											className="self-start sm:self-auto"
										>
											{generatedBatch ? (
												<RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
											) : (
												<LinkIcon data-icon="inline-start" aria-hidden="true" />
											)}
											{generatedBatch ? "Regenerate Links" : "Generate Links"}
										</Button>
									</div>

									{generatedBatch ? (
										<div className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-3">
											<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
												<Badge
													variant={remainingSeconds <= 10 ? "destructive" : "secondary"}
													aria-live="polite"
												>
													<TimerIcon data-icon="inline-start" aria-hidden="true" />
													Expires in {remainingSeconds}s
												</Badge>
												<div className="min-w-40 flex-1 sm:max-w-64">
													<Progress
														value={timerProgress}
														aria-label="Generated links time remaining"
													/>
												</div>
											</div>

											<div className="space-y-3">
												{generatedBatch.links.map((link) => {
													const copyState =
														copyStates[link.eventTypeConfigId] ?? "idle";

													return (
														<div
															key={link.eventTypeConfigId}
															className="space-y-2 rounded-lg border bg-background/80 p-3"
														>
															<p className="font-medium">
																{link.eventTypeDisplayName}
															</p>
															<div className="flex min-w-0 flex-col gap-2 sm:flex-row">
																<Input
																	id={`generated-booking-url-${link.eventTypeConfigId}`}
																	value={link.url}
																	readOnly
																	onFocus={(event) =>
																		event.currentTarget.select()
																	}
																	className="font-mono text-sm"
																	translate="no"
																	aria-label={`Booking link for ${link.eventTypeDisplayName}`}
																/>
																<Tooltip>
																	<TooltipTrigger asChild>
																		<Button
																			type="button"
																			size="icon"
																			className="self-start sm:self-auto"
																			aria-label={`Copy booking link for ${link.eventTypeDisplayName}`}
																			disabled={copyState === "copying"}
																			onClick={() => copyGeneratedUrl(link)}
																		>
																			{copyState === "copied" ? (
																				<CheckCircle2Icon aria-hidden="true" />
																			) : copyState === "copying" ? (
																				<Spinner />
																			) : (
																				<CopyIcon aria-hidden="true" />
																			)}
																		</Button>
																	</TooltipTrigger>
																	<TooltipContent>
																		Copy {link.eventTypeDisplayName}
																	</TooltipContent>
																</Tooltip>
															</div>
															<div aria-live="polite">
																{copyState === "copied" ? (
																	<FieldDescription>Copied.</FieldDescription>
																) : null}
																{copyState === "manual" ? (
																	<FieldDescription>
																		Clipboard access failed. The link is selected
																		for manual copy.
																	</FieldDescription>
																) : null}
															</div>
														</div>
													);
												})}
											</div>
										</div>
									) : (
										<div className="flex min-h-24 items-center gap-3 rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
											<LinkIcon className="size-5 shrink-0" aria-hidden="true" />
											<span>
												No active links. Generate them when the DM closer is ready
												to copy.
											</span>
										</div>
									)}

									{closer && campaign ? (
										<div
											className="flex flex-wrap gap-2"
											aria-label="Generated UTM values"
										>
											<Badge variant="secondary" translate="no">
												utm_source={closer.teamUtmSource}
											</Badge>
											<Badge variant="secondary" translate="no">
												utm_medium={closer.utmMedium}
											</Badge>
											<Badge variant="secondary" translate="no">
												utm_campaign={campaign.utmCampaign}
											</Badge>
										</div>
									) : null}
								</div>
							) : null}

							<div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-between">
								<Button
									type="button"
									variant="ghost"
									onClick={goBack}
									disabled={currentStepIndex === 0}
								>
									<ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
									Back
								</Button>
								{currentStep === "generate" ? (
									<Button
										type="button"
										variant="outline"
										onClick={resetPortalState}
									>
										<RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
										Start Over
									</Button>
								) : (
									<Button
										type="button"
										onClick={goNext}
										disabled={!isStepComplete(currentStep)}
									>
										Continue
										<ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
									</Button>
								)}
							</div>
						</div>
					</CardContent>
				</Card>
			</main>
		</>
	);
}
