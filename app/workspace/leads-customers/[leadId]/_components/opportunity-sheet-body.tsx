"use client";

import type { FunctionReturnType } from "convex/server";
import { CalendarXIcon } from "lucide-react";
import { EntityAttributionCard } from "@/app/workspace/_components/entity-attribution-card";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { OpportunityActivityTimeline } from "@/app/workspace/opportunities/[opportunityId]/_components/opportunity-activity-timeline";
import { OpportunityMeetingsList } from "@/app/workspace/opportunities/[opportunityId]/_components/opportunity-meetings-list";
import { OpportunityPaymentsList } from "@/app/workspace/opportunities/[opportunityId]/_components/opportunity-payments-list";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { api } from "@/convex/_generated/api";
import { meetingBasePathForRole } from "./meeting-link-utils";
import { OpportunitySheetBodySkeleton } from "./opportunity-sheet-skeleton";
import { OpportunitySheetSummary } from "./opportunity-sheet-summary";

type OpportunityDetail = FunctionReturnType<
	typeof api.opportunities.detailQuery.getOpportunityDetail
>;

export function OpportunitySheetBody({
	detail,
}: {
	detail: OpportunityDetail | undefined;
}) {
	if (detail === undefined) {
		return <OpportunitySheetBodySkeleton />;
	}

	if (detail === null) {
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

	const meetingBasePath = meetingBasePathForRole(detail.permissions.viewerRole);

	return (
		<div className="flex flex-col gap-4 p-4">
			<OpportunitySheetSummary detail={detail} />
			<SectionErrorBoundary sectionName="opportunity attribution">
				<EntityAttributionCard attribution={detail.attribution} />
			</SectionErrorBoundary>
			<SectionErrorBoundary sectionName="opportunity meetings">
				<section className="rounded-md border">
					<div className="border-b p-3">
						<h3 className="text-sm font-semibold">Meetings</h3>
					</div>
					<div className="p-3">
						<OpportunityMeetingsList
							meetings={detail.meetings}
							meetingBasePath={meetingBasePath}
							compact
						/>
					</div>
				</section>
			</SectionErrorBoundary>
			<SectionErrorBoundary sectionName="opportunity payments">
				<OpportunityPaymentsList payments={detail.payments} compact />
			</SectionErrorBoundary>
			<SectionErrorBoundary sectionName="opportunity activity">
				<OpportunityActivityTimeline events={detail.events} compact />
			</SectionErrorBoundary>
		</div>
	);
}
