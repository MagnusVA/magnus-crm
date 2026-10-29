"use client";

import { useMutation } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { UsersIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { getErrorMessage } from "@/lib/errors";

type PotentialDuplicateBannerProps = {
	duplicateLead: {
		_id: string;
		fullName?: string;
		email?: string;
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
	const duplicateLeadLabel =
		duplicateLead.fullName ?? duplicateLead.email ?? "Unknown lead";
	const showEmailDetail =
		duplicateLead.fullName !== undefined && duplicateLead.email !== undefined;

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
				getErrorMessage(error, "Failed to dismiss duplicate flag"),
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
			className="border-warning bg-warning-surface"
		>
			<UsersIcon
				aria-hidden="true"
				className="text-warning-ink"
			/>
			<AlertTitle className="text-foreground">
				Possible duplicate person
			</AlertTitle>
			<AlertDescription className="break-words text-warning-ink">
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
							className="border-warning bg-card text-foreground"
						>
							<XIcon data-icon="inline-start" />
							Dismiss
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={handleReviewMerge}
							className="border-warning bg-card text-foreground"
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
