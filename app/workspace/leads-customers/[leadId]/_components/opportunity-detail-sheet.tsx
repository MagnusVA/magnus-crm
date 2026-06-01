"use client";

import { useQuery } from "convex/react";
import { CalendarXIcon } from "lucide-react";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useOpportunitySheet } from "./opportunity-sheet-context";
import { OpportunitySheetBody } from "./opportunity-sheet-body";

const sheetClassName =
	"w-full overflow-y-auto overscroll-contain p-0 data-[side=right]:sm:max-w-3xl";

function OpportunityUnavailableState() {
	return (
		<div className="p-4">
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<CalendarXIcon aria-hidden="true" />
					</EmptyMedia>
					<EmptyTitle>Opportunity unavailable</EmptyTitle>
					<EmptyDescription>
						It may have been reassigned, removed, or outside your access.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		</div>
	);
}

function OpportunityDetailSheetContent({
	opportunityId,
}: {
	opportunityId: Id<"opportunities">;
}) {
	const detail = useQuery(api.opportunities.detailQuery.getOpportunityDetail, {
		opportunityId,
	});

	return <OpportunitySheetBody detail={detail} />;
}

export function OpportunityDetailSheet() {
	const {
		opportunityId,
		actions: { closeOpportunity },
	} = useOpportunitySheet();
	const isOpen = Boolean(opportunityId);

	return (
		<Sheet
			open={isOpen}
			onOpenChange={(open) => {
				if (!open) closeOpportunity();
			}}
		>
			<SheetContent side="right" className={sheetClassName}>
				<SheetHeader className="border-b border-border/60 bg-muted/20 px-4 py-3 pr-12 text-left">
					<SheetTitle className="font-heading text-base tracking-tight">
						Opportunity Detail
					</SheetTitle>
					<SheetDescription>
						Meetings, payments, attribution &amp; activity for the selected deal.
					</SheetDescription>
				</SheetHeader>
				{opportunityId ? (
					<SectionErrorBoundary
						sectionName="opportunity detail"
						fallback={<OpportunityUnavailableState />}
					>
						<OpportunityDetailSheetContent opportunityId={opportunityId} />
					</SectionErrorBoundary>
				) : null}
			</SheetContent>
		</Sheet>
	);
}
