"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { SectionEmpty, SectionError } from "@/app/workspace/closer/_components/section-state";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DealModalBody } from "./deal-modal-body";
import { DealModalHeaderFrame } from "./deal-modal-header";
import { DealModalSkeleton } from "./deal-modal-skeleton";
import { useOpportunitySheet } from "./opportunity-sheet-context";

// Centred, up to 42rem wide, the header fixed and the sections scrolling
// under it. On a phone it fills the screen but for a thin margin.
const dealModalClassName =
	"flex max-h-[calc(100dvh-1rem)] w-full max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[min(88dvh,56rem)] sm:max-w-2xl";

/** The header and one quiet line, for a deal that is gone or not the viewer's. */
function DealModalMessage({ children }: { children: React.ReactNode }) {
	return (
		<>
			<DealModalHeaderFrame>
				<DialogTitle className="text-lg leading-tight font-semibold">Deal</DialogTitle>
				<DialogDescription className="sr-only">This deal can&apos;t be shown.</DialogDescription>
			</DealModalHeaderFrame>
			{children}
		</>
	);
}

function DealModalContent({
	opportunityId,
	onDeleted,
}: {
	opportunityId: Id<"opportunities">;
	onDeleted: () => void;
}) {
	const detail = useQuery(api.opportunities.detailQuery.getOpportunityDetail, {
		opportunityId,
	});

	if (detail === undefined) return <DealModalSkeleton />;
	if (detail === null) {
		return (
			<DealModalMessage>
				<SectionEmpty className="py-5 sm:px-5" title="This deal isn't available.">
					It may have been deleted, or it belongs to another closer.
				</SectionEmpty>
			</DealModalMessage>
		);
	}
	return <DealModalBody detail={detail} onDeleted={onDeleted} />;
}

/**
 * The deal modal on the person page, opened from a deal card or a
 * `?opportunityId=` link (`OpportunitySheetProvider`). Closing it removes
 * the deal from the URL.
 */
export function OpportunityDetailSheet() {
	const {
		opportunityId,
		actions: { closeOpportunity },
	} = useOpportunitySheet();
	// The last deal shown stays in the modal while it fades out on close.
	const [shownId, setShownId] = useState(opportunityId);
	if (opportunityId && opportunityId !== shownId) setShownId(opportunityId);

	return (
		<Dialog
			open={Boolean(opportunityId)}
			onOpenChange={(open) => {
				if (!open) closeOpportunity();
			}}
		>
			<DialogContent showCloseButton={false} className={dealModalClassName}>
				{shownId ? (
					<SectionErrorBoundary
						key={shownId}
						sectionName="deal modal"
						fallback={
							<DealModalMessage>
								<SectionError what="this deal" className="py-5 sm:px-5" />
							</DealModalMessage>
						}
					>
						<DealModalContent opportunityId={shownId} onDeleted={closeOpportunity} />
					</SectionErrorBoundary>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
