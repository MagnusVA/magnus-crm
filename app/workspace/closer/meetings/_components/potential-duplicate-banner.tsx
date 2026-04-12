"use client";

import { useMutation } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { UsersIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";

type PotentialDuplicateBannerProps = {
	duplicateLead: {
		_id: string;
		fullName?: string;
		email: string;
	};
	currentLeadName?: string;
	opportunityId: Id<"opportunities">;
	currentLeadId: string;
};

export function PotentialDuplicateBanner({
	duplicateLead,
	currentLeadName,
	opportunityId,
	currentLeadId,
}: PotentialDuplicateBannerProps) {
	const duplicateLeadLabel = duplicateLead.fullName ?? duplicateLead.email;
	const showEmailDetail = duplicateLead.fullName !== undefined;

	const dismissDuplicateFlag = useMutation(
		api.leads.merge.dismissDuplicateFlag,
	);
	const [isDismissing, setIsDismissing] = useState(false);

	async function handleDismiss() {
		setIsDismissing(true);
		try {
			await dismissDuplicateFlag({ opportunityId });
			toast.success("Duplicate flag dismissed");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to dismiss duplicate flag",
			);
			setIsDismissing(false);
		}
	}

	function handleReviewMerge() {
		window.open(`/workspace/leads/${currentLeadId}/merge`, "_blank");
	}

	return (
		<Alert
			role="status"
			variant="default"
			className="border-amber-500 bg-amber-50 dark:bg-amber-950/20"
		>
			<UsersIcon
				aria-hidden="true"
				className="text-amber-600 dark:text-amber-400"
			/>
			<AlertTitle className="text-amber-800 dark:text-amber-200">
				Potential Duplicate Lead
			</AlertTitle>
			<AlertDescription className="break-words text-amber-700 dark:text-amber-300">
				<div className="flex flex-col gap-3">
					<p>
						{currentLeadName ? (
							<>
								<span className="font-medium">{currentLeadName}</span>{" "}
								might be the same person as{" "}
								<span className="font-medium">{duplicateLeadLabel}</span>
								{showEmailDetail
									? ` (${duplicateLead.email})`
									: null}
								.
							</>
						) : (
							<>
								This lead might be the same as{" "}
								<span className="font-medium">{duplicateLeadLabel}</span>
								{showEmailDetail
									? ` (${duplicateLead.email})`
									: null}
								.
							</>
						)}{" "}
						Review their profiles to determine if they should be merged.
					</p>
					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={handleDismiss}
							disabled={isDismissing}
							className="border-amber-400 text-amber-800 hover:bg-amber-100 dark:border-amber-600 dark:text-amber-200 dark:hover:bg-amber-900/30"
						>
							<XIcon data-icon="inline-start" />
							Dismiss
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={handleReviewMerge}
							className="border-amber-400 text-amber-800 hover:bg-amber-100 dark:border-amber-600 dark:text-amber-200 dark:hover:bg-amber-900/30"
						>
							<ExternalLinkIcon data-icon="inline-start" />
							Review &amp; Merge
						</Button>
					</div>
				</div>
			</AlertDescription>
		</Alert>
	);
}
