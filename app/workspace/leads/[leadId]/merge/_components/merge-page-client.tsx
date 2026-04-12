"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";

type LeadListItem = Doc<"leads"> & {
	opportunityCount: number;
	latestMeetingAt: number | null;
	assignedCloserName: string | null;
};
import { usePageTitle } from "@/hooks/use-page-title";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
	ArrowLeftIcon,
	UserIcon,
	SearchIcon,
	MergeIcon,
} from "lucide-react";

import { LeadSearchInput } from "../../../_components/lead-search-input";
import { MergePreview } from "./merge-preview";

type MergeStep = "search" | "preview" | "confirming";

export function MergePageClient() {
	const params = useParams();
	const router = useRouter();
	const sourceLeadId = params.leadId as Id<"leads">;

	usePageTitle("Merge Leads");

	const [step, setStep] = useState<MergeStep>("search");
	const [searchTerm, setSearchTerm] = useState("");
	const [selectedTargetId, setSelectedTargetId] = useState<Id<"leads"> | null>(
		null,
	);
	const [isConfirmOpen, setIsConfirmOpen] = useState(false);
	const [isMerging, setIsMerging] = useState(false);

	// Source lead info
	const sourceDetail = useQuery(api.leads.queries.getLeadDetail, {
		leadId: sourceLeadId,
	});

	// Search for merge targets (only when user is searching)
	const searchResults = useQuery(
		api.leads.queries.searchLeads,
		searchTerm.length >= 2 ? { searchTerm } : "skip",
	);

	// Merge preview (only when target is selected)
	const mergePreview = useQuery(
		api.leads.queries.getMergePreview,
		selectedTargetId
			? { sourceLeadId, targetLeadId: selectedTargetId }
			: "skip",
	);

	const mergeLead = useMutation(api.leads.merge.mergeLead);

	// Filter out the source lead from search results
	// searchLeads returns enriched LeadListItem at runtime
	const filteredResults = (searchResults as LeadListItem[] | undefined)?.filter(
		(lead) => lead._id !== sourceLeadId,
	);

	const sourceLead = sourceDetail?.lead;

	function handleSelectTarget(targetId: Id<"leads">) {
		setSelectedTargetId(targetId);
		setStep("preview");
	}

	function handleBackToSearch() {
		setSelectedTargetId(null);
		setStep("search");
	}

	async function handleConfirmMerge() {
		if (!selectedTargetId) return;

		setIsMerging(true);
		try {
			await mergeLead({
				sourceLeadId,
				targetLeadId: selectedTargetId,
			});
			toast.success("Leads merged successfully");
			router.replace(`/workspace/leads/${selectedTargetId}`);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to merge leads",
			);
			setIsMerging(false);
			setIsConfirmOpen(false);
		}
	}

	// Loading state for source lead
	if (sourceDetail === undefined) {
		return (
			<div className="flex items-center justify-center py-12">
				<Spinner className="h-6 w-6" />
			</div>
		);
	}

	// Redirect if source lead was merged
	if (sourceDetail?.redirectToLeadId) {
		router.replace(
			`/workspace/leads/${sourceDetail.redirectToLeadId}/merge`,
		);
		return null;
	}

	if (!sourceLead) {
		return (
			<div className="flex flex-col gap-4 py-12 text-center">
				<p className="text-muted-foreground">Lead not found.</p>
				<Button
					variant="ghost"
					onClick={() => router.push("/workspace/leads")}
				>
					<ArrowLeftIcon data-icon="inline-start" />
					Back to Leads
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			{/* Back link */}
			<Button
				variant="ghost"
				size="sm"
				className="w-fit"
				onClick={() => router.back()}
			>
				<ArrowLeftIcon data-icon="inline-start" />
				Back
			</Button>

			{/* Page header */}
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">
					Merge Leads
				</h1>
				<p className="text-muted-foreground">
					Merge{" "}
					<span className="font-medium text-foreground">
						{sourceLead.fullName ?? "Unknown Lead"}
					</span>{" "}
					into another lead. The source lead will be absorbed and marked
					as merged.
				</p>
			</div>

			{/* Source lead summary */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<UserIcon className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">Source Lead</CardTitle>
						<Badge variant="destructive" className="ml-auto">
							Will be absorbed
						</Badge>
					</div>
				</CardHeader>
				<CardContent>
					<div className="flex items-center gap-3">
						<div>
							<p className="font-medium">
								{sourceLead.fullName ?? "Unknown"}
							</p>
							{sourceLead.email && (
								<p className="text-sm text-muted-foreground">
									{sourceLead.email}
								</p>
							)}
							{sourceLead.phone && (
								<p className="text-sm text-muted-foreground">
									{sourceLead.phone}
								</p>
							)}
						</div>
					</div>
				</CardContent>
			</Card>

			{/* Step: Search for target */}
			{step === "search" && (
				<Card>
					<CardHeader>
						<div className="flex items-center gap-2">
							<SearchIcon className="h-4 w-4 text-muted-foreground" />
							<CardTitle className="text-base">
								Select Target Lead
							</CardTitle>
						</div>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						<p className="text-sm text-muted-foreground">
							Search for the lead that should survive after the merge.
						</p>
						<LeadSearchInput
							value={searchTerm}
							onChange={setSearchTerm}
						/>

						{/* Search results */}
						{searchTerm.length >= 2 && (
							<div className="flex flex-col gap-1">
								{searchResults === undefined ? (
									<div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
										<Spinner className="h-4 w-4" />
										Searching...
									</div>
								) : filteredResults && filteredResults.length > 0 ? (
									<div className="rounded-md border">
										{filteredResults.map((lead) => (
											<button
												key={lead._id}
												type="button"
												onClick={() =>
													handleSelectTarget(
														lead._id as Id<"leads">,
													)
												}
												className="flex w-full items-center gap-3 border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/50"
											>
												<UserIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
												<div className="min-w-0 flex-1">
													<p className="truncate text-sm font-medium">
														{lead.fullName ?? "Unknown"}
													</p>
													{lead.email && (
														<p className="truncate text-xs text-muted-foreground">
															{lead.email}
														</p>
													)}
												</div>
												<Badge
													variant="outline"
													className="shrink-0 text-xs"
												>
													{lead.opportunityCount}{" "}
													{lead.opportunityCount === 1
														? "opp"
														: "opps"}
												</Badge>
											</button>
										))}
									</div>
								) : (
									<p className="py-4 text-center text-sm text-muted-foreground">
										No matching leads found.
									</p>
								)}
							</div>
						)}

						{searchTerm.length > 0 && searchTerm.length < 2 && (
							<p className="text-sm text-muted-foreground">
								Type at least 2 characters to search.
							</p>
						)}
					</CardContent>
				</Card>
			)}

			{/* Step: Preview */}
			{step === "preview" && (
				<div className="flex flex-col gap-4">
					<div className="flex items-center justify-between">
						<Button
							variant="ghost"
							size="sm"
							onClick={handleBackToSearch}
						>
							<ArrowLeftIcon data-icon="inline-start" />
							Change target
						</Button>
					</div>

					{mergePreview === undefined ? (
						<div className="flex items-center justify-center py-12">
							<Spinner className="h-6 w-6" />
						</div>
					) : (
						<>
							<MergePreview data={mergePreview} />

							<div className="flex justify-end gap-3 border-t pt-4">
								<Button
									variant="outline"
									onClick={handleBackToSearch}
								>
									Cancel
								</Button>
								<Button
									variant="destructive"
									onClick={() => {
										setStep("confirming");
										setIsConfirmOpen(true);
									}}
								>
									<MergeIcon data-icon="inline-start" />
									Merge Leads
								</Button>
							</div>
						</>
					)}
				</div>
			)}

			{/* Confirmation dialog */}
			<AlertDialog
				open={isConfirmOpen}
				onOpenChange={(open) => {
					if (!open && !isMerging) {
						setIsConfirmOpen(false);
						setStep("preview");
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Confirm Lead Merge</AlertDialogTitle>
						<AlertDialogDescription>
							This action cannot be undone.{" "}
							<span className="font-medium text-foreground">
								{sourceLead.fullName ?? "Source lead"}
							</span>{" "}
							will be permanently absorbed into{" "}
							<span className="font-medium text-foreground">
								{mergePreview?.target.lead.fullName ?? "the target lead"}
							</span>
							. All identifiers and opportunities will be transferred.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isMerging}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleConfirmMerge}
							disabled={isMerging}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{isMerging ? (
								<>
									<Spinner className="h-4 w-4" />
									Merging...
								</>
							) : (
								"Confirm Merge"
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
