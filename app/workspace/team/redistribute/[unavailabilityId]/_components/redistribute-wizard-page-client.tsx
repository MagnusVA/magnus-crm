"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { useRole } from "@/components/auth/role-context";
import { format } from "date-fns";
import { toast } from "sonner";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	CheckCircle2Icon,
	ChevronRightIcon,
	CircleAlertIcon,
	LoaderIcon,
	PartyPopperIcon,
	ShuffleIcon,
	UserIcon,
	XCircleIcon,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────

type WizardStep = "review" | "distribute" | "resolve" | "complete";

const WIZARD_STEPS: WizardStep[] = [
	"review",
	"distribute",
	"resolve",
	"complete",
];

const STEP_LABELS: Record<WizardStep, string> = {
	review: "Review",
	distribute: "Distribute",
	resolve: "Resolve",
	complete: "Done",
};

interface RedistributeWizardProps {
	unavailabilityId: Id<"closerUnavailability">;
}

// Matches the shape returned by getUnavailabilityWithMeetings → affectedMeetings
interface MeetingForRedistribution {
	meetingId: Id<"meetings">;
	opportunityId: Id<"opportunities">;
	scheduledAt: number;
	durationMinutes: number;
	leadName: string | undefined;
	meetingJoinUrl: string | undefined;
	status: string;
	alreadyReassigned: boolean;
}

// Matches the shape returned by getAvailableClosersForDate
interface AvailableCloser {
	closerId: Id<"users">;
	closerName: string;
	isAvailable: boolean;
	unavailabilityReason: string | null;
	meetingsToday: number;
	meetings: Array<{ scheduledAt: number; durationMinutes: number }>;
	blockedRanges: Array<{
		rangeStart: number;
		rangeEnd: number;
		reason: string;
		isFullDay: boolean;
	}>;
}

// Matches the return type of autoDistributeMeetings
interface DistributionResult {
	assigned: Array<{
		meetingId: Id<"meetings">;
		toCloserId: Id<"users">;
		toCloserName: string;
	}>;
	unassigned: Array<{
		meetingId: Id<"meetings">;
		reason: string;
	}>;
}

// ─── Main Component ─────────────────────────────────────────────────

export function RedistributeWizardPageClient({
	unavailabilityId,
}: RedistributeWizardProps) {
	usePageTitle("Redistribute Meetings");
	const router = useRouter();
	const { isAdmin } = useRole();

	// ── Wizard state ──
	const [step, setStep] = useState<WizardStep>("review");
	const [selectedMeetingIds, setSelectedMeetingIds] = useState<
		Set<Id<"meetings">>
	>(new Set());
	const [selectedCloserIds, setSelectedCloserIds] = useState<
		Set<Id<"users">>
	>(new Set());
	const [isDistributing, setIsDistributing] = useState(false);
	const [distributionResult, setDistributionResult] =
		useState<DistributionResult | null>(null);

	// ── Resolve step state ──
	const [currentResolveIndex, setCurrentResolveIndex] = useState(0);
	const [resolveCloserId, setResolveCloserId] = useState<string>("");
	const [isResolving, setIsResolving] = useState(false);
	const [resolvedCount, setResolvedCount] = useState(0);

	// ── Queries ──
	const data = useQuery(
		api.unavailability.queries.getUnavailabilityWithMeetings,
		{ unavailabilityId },
	);

	const availableClosers = useQuery(
		api.unavailability.queries.getAvailableClosersForDate,
		data
			? {
					date: data.unavailability.date,
					excludeCloserId: data.unavailability
						.closerId as Id<"users">,
				}
			: "skip",
	);

	// ── Mutations ──
	const autoDistribute = useMutation(
		api.unavailability.redistribution.autoDistributeMeetings,
	);
	const manuallyResolve = useMutation(
		api.unavailability.redistribution.manuallyResolveMeeting,
	);

	// ── Derived data ──
	const meetings = data?.affectedMeetings ?? [];
	const pendingMeetings = useMemo(
		() => meetings.filter((m) => !m.alreadyReassigned),
		[meetings],
	);
	const sortedMeetings = useMemo(
		() => [...meetings].sort((a, b) => a.scheduledAt - b.scheduledAt),
		[meetings],
	);

	const typedClosers = (availableClosers ?? []) as AvailableCloser[];
	const enabledClosers = useMemo(
		() => typedClosers.filter((c) => c.isAvailable),
		[typedClosers],
	);

	// ── Meeting selection handlers ──
	const toggleMeeting = useCallback((meetingId: Id<"meetings">) => {
		setSelectedMeetingIds((prev) => {
			const next = new Set(prev);
			if (next.has(meetingId)) {
				next.delete(meetingId);
			} else {
				next.add(meetingId);
			}
			return next;
		});
	}, []);

	const toggleAllMeetings = useCallback(() => {
		setSelectedMeetingIds((prev) => {
			if (prev.size === pendingMeetings.length) {
				return new Set();
			}
			return new Set(pendingMeetings.map((m) => m.meetingId));
		});
	}, [pendingMeetings]);

	// ── Closer selection handlers ──
	const toggleCloser = useCallback(
		(closerId: Id<"users">) => {
			const closer = typedClosers.find((c) => c.closerId === closerId);
			if (!closer?.isAvailable) return;
			setSelectedCloserIds((prev) => {
				const next = new Set(prev);
				if (next.has(closerId)) {
					next.delete(closerId);
				} else {
					next.add(closerId);
				}
				return next;
			});
		},
		[typedClosers],
	);

	// ── Auto-distribute handler ──
	const handleAutoDistribute = useCallback(async () => {
		if (selectedMeetingIds.size === 0 || selectedCloserIds.size === 0)
			return;
		setIsDistributing(true);
		try {
			const result = await autoDistribute({
				unavailabilityId,
				meetingIds: Array.from(selectedMeetingIds),
				candidateCloserIds: Array.from(selectedCloserIds),
			});
			setDistributionResult(result);
			if (result.unassigned.length === 0) {
				setStep("complete");
				toast.success(
					`Successfully redistributed ${result.assigned.length} meeting${result.assigned.length === 1 ? "" : "s"}`,
				);
			} else {
				setCurrentResolveIndex(0);
				setResolveCloserId("");
				setStep("resolve");
				toast.info(
					`${result.assigned.length} meeting${result.assigned.length === 1 ? "" : "s"} assigned. ${result.unassigned.length} need${result.unassigned.length === 1 ? "s" : ""} manual resolution.`,
				);
			}
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to distribute meetings",
			);
		} finally {
			setIsDistributing(false);
		}
	}, [
		selectedMeetingIds,
		selectedCloserIds,
		unavailabilityId,
		autoDistribute,
	]);

	// ── Manual resolve handlers ──
	const unassignedMeetings = useMemo(() => {
		if (!distributionResult) return [];
		const unassignedIds = new Set(
			distributionResult.unassigned.map((u) => u.meetingId),
		);
		return sortedMeetings.filter((m) => unassignedIds.has(m.meetingId));
	}, [distributionResult, sortedMeetings]);

	const currentUnassigned =
		unassignedMeetings[currentResolveIndex] ?? null;

	const handleForceAssign = useCallback(async () => {
		if (!currentUnassigned || !resolveCloserId) return;
		setIsResolving(true);
		try {
			await manuallyResolve({
				unavailabilityId,
				meetingId: currentUnassigned.meetingId,
				targetCloserId: resolveCloserId as Id<"users">,
				action: "assign",
			});
			const nextResolved = resolvedCount + 1;
			setResolvedCount(nextResolved);
			const nextIndex = currentResolveIndex + 1;
			if (nextIndex >= unassignedMeetings.length) {
				setStep("complete");
				toast.success("All meetings have been resolved");
			} else {
				setCurrentResolveIndex(nextIndex);
				setResolveCloserId("");
			}
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to assign meeting",
			);
		} finally {
			setIsResolving(false);
		}
	}, [
		currentUnassigned,
		resolveCloserId,
		unavailabilityId,
		manuallyResolve,
		currentResolveIndex,
		unassignedMeetings.length,
		resolvedCount,
	]);

	const handleCancelMeeting = useCallback(async () => {
		if (!currentUnassigned) return;
		setIsResolving(true);
		try {
			await manuallyResolve({
				unavailabilityId,
				meetingId: currentUnassigned.meetingId,
				action: "cancel",
			});
			const nextIndex = currentResolveIndex + 1;
			if (nextIndex >= unassignedMeetings.length) {
				setStep("complete");
				toast.success("All meetings have been resolved");
			} else {
				setCurrentResolveIndex(nextIndex);
				setResolveCloserId("");
			}
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to cancel meeting",
			);
		} finally {
			setIsResolving(false);
		}
	}, [
		currentUnassigned,
		unavailabilityId,
		manuallyResolve,
		currentResolveIndex,
		unassignedMeetings.length,
	]);

	// ── Total redistributed count for completion ──
	const totalRedistributed =
		(distributionResult?.assigned.length ?? 0) + resolvedCount;

	// ── Guard: loading or unauthorized ──
	if (!isAdmin) {
		return <WizardSkeleton />;
	}

	if (data === undefined) {
		return <WizardSkeleton />;
	}

	if (data === null) {
		return (
			<div className="flex flex-col items-center justify-center gap-4 py-20">
				<CircleAlertIcon className="size-12 text-muted-foreground" />
				<p className="text-muted-foreground">
					Unavailability record not found or you do not have access.
				</p>
				<Button
					variant="outline"
					onClick={() => router.push("/workspace/team")}
				>
					<ArrowLeftIcon data-icon="inline-start" />
					Back to Team
				</Button>
			</div>
		);
	}

	const { unavailability } = data;
	const closerName = unavailability.closerName;

	return (
		<div className="flex flex-col gap-6">
			{/* ── Header ── */}
			<div className="space-y-1">
				<div className="flex items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => router.push("/workspace/team")}
					>
						<ArrowLeftIcon data-icon="inline-start" />
						Team
					</Button>
				</div>
				<h1 className="text-2xl font-bold tracking-tight">
					Redistribute Meetings
				</h1>
				<p className="text-muted-foreground">
					{closerName} is unavailable on{" "}
					{format(new Date(unavailability.date), "EEEE, MMMM d, yyyy")}
					{unavailability.reason !== "other" && (
						<>
							{" "}
							&mdash;{" "}
							<span className="capitalize">
								{unavailability.reason}
							</span>
						</>
					)}
					{unavailability.note && (
						<>
							{" "}
							({unavailability.note})
						</>
					)}
				</p>
			</div>

			{/* ── Step Indicator ── */}
			<div className="flex items-center gap-1.5">
				{WIZARD_STEPS.map((s, i) => {
					const stepIndex = WIZARD_STEPS.indexOf(step);
					const isDone = i < stepIndex;
					const isActive = s === step;
					return (
						<div key={s} className="flex items-center gap-1.5">
							{i > 0 && (
								<ChevronRightIcon className="size-4 text-muted-foreground" />
							)}
							<StepBadge
								label={STEP_LABELS[s]}
								isActive={isActive}
								isDone={isDone}
							/>
						</div>
					);
				})}
			</div>

			<Separator />

			{/* ── Step Content ── */}
			{step === "review" && (
				<ReviewStep
					meetings={sortedMeetings}
					pendingMeetings={pendingMeetings}
					selectedMeetingIds={selectedMeetingIds}
					onToggleMeeting={toggleMeeting}
					onToggleAll={toggleAllMeetings}
					onNext={() => setStep("distribute")}
				/>
			)}
			{step === "distribute" && (
				<DistributeStep
					closers={typedClosers}
					enabledClosers={enabledClosers}
					selectedCloserIds={selectedCloserIds}
					selectedMeetingCount={selectedMeetingIds.size}
					onToggleCloser={toggleCloser}
					onBack={() => setStep("review")}
					onDistribute={handleAutoDistribute}
					isDistributing={isDistributing}
				/>
			)}
			{step === "resolve" && (
				<ResolveStep
					meeting={currentUnassigned}
					currentIndex={currentResolveIndex}
					totalCount={unassignedMeetings.length}
					closers={enabledClosers}
					resolveCloserId={resolveCloserId}
					onResolveCloserChange={setResolveCloserId}
					onForceAssign={handleForceAssign}
					onCancelMeeting={handleCancelMeeting}
					isResolving={isResolving}
				/>
			)}
			{step === "complete" && (
				<CompleteStep
					redistributedCount={totalRedistributed}
					onBackToTeam={() => router.push("/workspace/team")}
				/>
			)}
		</div>
	);
}

// ─── Step Badge ─────────────────────────────────────────────────────

function StepBadge({
	label,
	isActive,
	isDone,
}: {
	label: string;
	isActive: boolean;
	isDone: boolean;
}) {
	if (isDone) {
		return (
			<Badge variant="secondary" className="gap-1">
				<CheckCircle2Icon className="size-3" />
				{label}
			</Badge>
		);
	}
	if (isActive) {
		return <Badge>{label}</Badge>;
	}
	return <Badge variant="outline">{label}</Badge>;
}

// ─── Wizard Skeleton ────────────────────────────────────────────────

function WizardSkeleton() {
	return (
		<div
			className="flex flex-col gap-6"
			role="status"
			aria-label="Loading redistribution wizard"
		>
			<div className="space-y-2">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-96" />
			</div>
			<div className="flex items-center gap-2">
				<Skeleton className="h-6 w-20 rounded-full" />
				<Skeleton className="h-4 w-4" />
				<Skeleton className="h-6 w-24 rounded-full" />
				<Skeleton className="h-4 w-4" />
				<Skeleton className="h-6 w-22 rounded-full" />
			</div>
			<Skeleton className="h-px w-full" />
			<Skeleton className="h-[400px] w-full rounded-xl" />
		</div>
	);
}

// ─── Review Step ────────────────────────────────────────────────────

function ReviewStep({
	meetings,
	pendingMeetings,
	selectedMeetingIds,
	onToggleMeeting,
	onToggleAll,
	onNext,
}: {
	meetings: MeetingForRedistribution[];
	pendingMeetings: MeetingForRedistribution[];
	selectedMeetingIds: Set<Id<"meetings">>;
	onToggleMeeting: (id: Id<"meetings">) => void;
	onToggleAll: () => void;
	onNext: () => void;
}) {
	const allSelected =
		pendingMeetings.length > 0 &&
		selectedMeetingIds.size === pendingMeetings.length;

	return (
		<Card>
			<CardHeader>
				<CardTitle>Select Meetings to Redistribute</CardTitle>
				<CardDescription>
					Choose which meetings need to be reassigned to other
					closers. Meetings already reassigned are shown for
					reference.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{meetings.length === 0 ? (
					<Alert>
						<AlertDescription>
							No meetings found for this date. Nothing to
							redistribute.
						</AlertDescription>
					</Alert>
				) : (
					<>
						{/* Select All */}
						{pendingMeetings.length > 0 && (
							<label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed p-3 hover:bg-muted/50">
								<Checkbox
									checked={allSelected}
									onCheckedChange={onToggleAll}
									aria-label="Select all pending meetings"
								/>
								<span className="text-sm font-medium">
									Select All ({pendingMeetings.length}{" "}
									meeting
									{pendingMeetings.length === 1
										? ""
										: "s"}
									)
								</span>
							</label>
						)}

						{/* Meeting list */}
						<div className="flex flex-col gap-2">
							{meetings.map((meeting) => {
								const isPending = !meeting.alreadyReassigned;
								const isSelected = selectedMeetingIds.has(
									meeting.meetingId,
								);
								return (
									<label
										key={meeting.meetingId}
										className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
											isPending
												? "cursor-pointer hover:bg-muted/50"
												: "cursor-default opacity-60"
										} ${isSelected ? "border-primary bg-primary/5" : ""}`}
									>
										<Checkbox
											checked={isSelected}
											onCheckedChange={() =>
												onToggleMeeting(
													meeting.meetingId,
												)
											}
											disabled={!isPending}
											aria-label={`Select meeting with ${meeting.leadName ?? "Unknown"}`}
										/>
										<div className="flex flex-1 items-center justify-between gap-2">
											<div className="flex flex-col gap-0.5">
												<span className="text-sm font-medium">
													{meeting.leadName ??
														"Unknown Lead"}
												</span>
												<span className="text-xs text-muted-foreground">
													{format(
														new Date(
															meeting.scheduledAt,
														),
														"h:mm a",
													)}{" "}
													&middot;{" "}
													{meeting.durationMinutes}{" "}
													min
												</span>
											</div>
											{meeting.alreadyReassigned && (
												<Badge
													variant="secondary"
													className="text-xs"
												>
													Already Reassigned
												</Badge>
											)}
										</div>
									</label>
								);
							})}
						</div>
					</>
				)}

				{/* Actions */}
				<div className="flex justify-end pt-2">
					<Button
						onClick={onNext}
						disabled={selectedMeetingIds.size === 0}
					>
						Next
						<ArrowRightIcon data-icon="inline-end" />
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

// ─── Distribute Step ────────────────────────────────────────────────

function DistributeStep({
	closers,
	enabledClosers,
	selectedCloserIds,
	selectedMeetingCount,
	onToggleCloser,
	onBack,
	onDistribute,
	isDistributing,
}: {
	closers: AvailableCloser[];
	enabledClosers: AvailableCloser[];
	selectedCloserIds: Set<Id<"users">>;
	selectedMeetingCount: number;
	onToggleCloser: (id: Id<"users">) => void;
	onBack: () => void;
	onDistribute: () => void;
	isDistributing: boolean;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Choose Target Closers</CardTitle>
				<CardDescription>
					Select which closers should receive the{" "}
					{selectedMeetingCount} selected meeting
					{selectedMeetingCount === 1 ? "" : "s"}. Meetings
					will be distributed based on current workload.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{closers.length === 0 ? (
					<Alert>
						<CircleAlertIcon className="size-4" />
						<AlertDescription>
							No other closers found. You may need to invite
							team members before redistributing.
						</AlertDescription>
					</Alert>
				) : (
					<div className="flex flex-col gap-2">
						{closers.map((closer) => {
							const isSelected = selectedCloserIds.has(
								closer.closerId,
							);
							const meetingBadgeColor =
								closer.meetingsToday === 0
									? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
									: closer.meetingsToday <= 3
										? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
										: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300";

							return (
								<label
									key={closer.closerId}
									className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
										closer.isAvailable
											? "cursor-pointer hover:bg-muted/50"
											: "cursor-default opacity-50"
									} ${isSelected ? "border-primary bg-primary/5" : ""}`}
								>
									<Checkbox
										checked={isSelected}
										onCheckedChange={() =>
											onToggleCloser(closer.closerId)
										}
										disabled={!closer.isAvailable}
										aria-label={`Select ${closer.closerName}`}
									/>
									<UserIcon className="size-4 shrink-0 text-muted-foreground" />
									<div className="flex flex-1 items-center justify-between gap-2">
										<div className="flex flex-col gap-0.5">
											<span className="text-sm font-medium">
												{closer.closerName}
											</span>
											{!closer.isAvailable &&
												closer.unavailabilityReason && (
													<span className="text-xs text-destructive">
														Unavailable:{" "}
														{
															closer.unavailabilityReason
														}
													</span>
												)}
										</div>
										{closer.isAvailable && (
											<Badge
												variant="secondary"
												className={`text-xs ${meetingBadgeColor}`}
											>
												{closer.meetingsToday}{" "}
												meeting
												{closer.meetingsToday === 1
													? ""
													: "s"}{" "}
												today
											</Badge>
										)}
									</div>
								</label>
							);
						})}
					</div>
				)}

				{/* Actions */}
				<div className="flex justify-between pt-2">
					<Button
						variant="outline"
						onClick={onBack}
						disabled={isDistributing}
					>
						<ArrowLeftIcon data-icon="inline-start" />
						Back
					</Button>
					<Button
						onClick={onDistribute}
						disabled={
							selectedCloserIds.size === 0 ||
							isDistributing ||
							enabledClosers.length === 0
						}
					>
						{isDistributing ? (
							<>
								<LoaderIcon className="size-4 animate-spin" />
								Distributing...
							</>
						) : (
							<>
								<ShuffleIcon data-icon="inline-start" />
								Auto-Distribute
							</>
						)}
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

// ─── Resolve Step ───────────────────────────────────────────────────

function ResolveStep({
	meeting,
	currentIndex,
	totalCount,
	closers,
	resolveCloserId,
	onResolveCloserChange,
	onForceAssign,
	onCancelMeeting,
	isResolving,
}: {
	meeting: MeetingForRedistribution | null;
	currentIndex: number;
	totalCount: number;
	closers: AvailableCloser[];
	resolveCloserId: string;
	onResolveCloserChange: (value: string) => void;
	onForceAssign: () => void;
	onCancelMeeting: () => void;
	isResolving: boolean;
}) {
	if (!meeting) {
		return (
			<Card>
				<CardContent className="py-8 text-center text-muted-foreground">
					No more meetings to resolve.
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Resolve Unassigned Meetings</CardTitle>
				<CardDescription>
					{currentIndex + 1} of {totalCount} &mdash; These
					meetings could not be automatically distributed and need
					manual resolution.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{/* Meeting detail */}
				<div className="rounded-lg border bg-muted/30 p-4">
					<div className="flex items-center justify-between">
						<div className="flex flex-col gap-0.5">
							<span className="text-sm font-medium">
								{meeting.leadName ?? "Unknown Lead"}
							</span>
							<span className="text-xs text-muted-foreground">
								{format(
									new Date(meeting.scheduledAt),
									"h:mm a",
								)}{" "}
								&middot; {meeting.durationMinutes} min
							</span>
						</div>
						<Badge variant="outline" className="text-xs">
							{currentIndex + 1}/{totalCount}
						</Badge>
					</div>
				</div>

				{/* Closer select */}
				<div className="flex flex-col gap-2">
					<label
						htmlFor="resolve-closer-select"
						className="text-sm font-medium"
					>
						Assign to Closer
					</label>
					<Select
						value={resolveCloserId}
						onValueChange={onResolveCloserChange}
					>
						<SelectTrigger id="resolve-closer-select">
							<SelectValue placeholder="Select a closer..." />
						</SelectTrigger>
						<SelectContent>
							{closers.map((closer) => (
								<SelectItem
									key={closer.closerId}
									value={closer.closerId}
								>
									{closer.closerName} (
									{closer.meetingsToday} meeting
									{closer.meetingsToday === 1
										? ""
										: "s"}{" "}
									today)
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				{/* Actions */}
				<div className="flex justify-between pt-2">
					<Button
						variant="destructive"
						onClick={onCancelMeeting}
						disabled={isResolving}
					>
						{isResolving ? (
							<LoaderIcon className="size-4 animate-spin" />
						) : (
							<XCircleIcon data-icon="inline-start" />
						)}
						Cancel Meeting
					</Button>
					<Button
						onClick={onForceAssign}
						disabled={!resolveCloserId || isResolving}
					>
						{isResolving ? (
							<>
								<LoaderIcon className="size-4 animate-spin" />
								Assigning...
							</>
						) : (
							<>
								<UserIcon data-icon="inline-start" />
								Force Assign
							</>
						)}
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

// ─── Complete Step ──────────────────────────────────────────────────

function CompleteStep({
	redistributedCount,
	onBackToTeam,
}: {
	redistributedCount: number;
	onBackToTeam: () => void;
}) {
	return (
		<Card>
			<CardContent className="flex flex-col items-center gap-4 py-12">
				<div className="flex size-16 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950">
					<PartyPopperIcon className="size-8 text-emerald-600 dark:text-emerald-400" />
				</div>
				<h2 className="text-xl font-semibold">
					Redistribution Complete
				</h2>
				<p className="text-center text-muted-foreground">
					{redistributedCount > 0
						? `${redistributedCount} meeting${redistributedCount === 1 ? " has" : "s have"} been successfully redistributed.`
						: "All meetings have been resolved."}
				</p>
				<Button onClick={onBackToTeam} className="mt-2">
					<ArrowLeftIcon data-icon="inline-start" />
					Back to Team
				</Button>
			</CardContent>
		</Card>
	);
}
