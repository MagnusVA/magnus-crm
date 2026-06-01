"use client";

import type { FunctionReturnType } from "convex/server";
import { CalendarClockIcon, CalendarXIcon, TagsIcon } from "lucide-react";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import type { EntityAttribution } from "@/app/workspace/_components/entity-attribution-card";
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
import { TruncatingTooltip } from "../../_components/entity-ui-tooltips";
import { formatDateTime } from "./entity-detail-formatters";
import { MicroLabel, SectionShell } from "./entity-detail-ui";
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
			{detail.attribution ? (
				<SectionErrorBoundary sectionName="opportunity attribution">
					<SheetAttribution attribution={detail.attribution} />
				</SectionErrorBoundary>
			) : null}
			<SectionErrorBoundary sectionName="opportunity meetings">
				<SectionShell
					title="Meetings"
					icon={<CalendarClockIcon aria-hidden="true" />}
					count={detail.meetings.length || undefined}
					bodyClassName="p-3"
				>
					<OpportunityMeetingsList
						meetings={detail.meetings}
						meetingBasePath={meetingBasePath}
						compact
					/>
				</SectionShell>
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

function SheetAttribution({ attribution }: { attribution: EntityAttribution }) {
	const dmTeam =
		attribution.dmAttribution.teamName ??
		attribution.dmAttribution.rawSource ??
		"None";
	const dmCloser =
		attribution.dmAttribution.dmCloserName ??
		attribution.dmAttribution.rawMedium ??
		"None";

	const fields: Array<[string, string]> = [
		["Slack qualifier", attribution.slackQualification?.slackUserLabel ?? "Not qualified"],
		["Booked program", attribution.bookedProgram?.name ?? "Unmapped"],
		["Sold program", attribution.soldProgram?.name ?? "No payment"],
		["DM team", dmTeam],
		["DM closer", dmCloser],
		["Phone closer", attribution.phoneCloser?.name ?? "Unassigned"],
		["Qualified", formatDateTime(attribution.timeline.qualifiedAt)],
		["First booked", formatDateTime(attribution.timeline.firstBookedAt)],
		["First meeting", formatDateTime(attribution.timeline.firstMeetingAt)],
		["Payment received", formatDateTime(attribution.timeline.paymentReceivedAt)],
	];

	return (
		<SectionShell
			title="Attribution"
			icon={<TagsIcon aria-hidden="true" />}
			bodyClassName="p-4"
		>
			<dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
				{fields.map(([label, value]) => (
					<div key={label} className="flex min-w-0 flex-col gap-0.5">
						<dt>
							<MicroLabel>{label}</MicroLabel>
						</dt>
						<TruncatingTooltip content={value}>
							<dd className="truncate text-sm font-medium" translate="no">
								{value}
							</dd>
						</TruncatingTooltip>
					</div>
				))}
			</dl>
		</SectionShell>
	);
}
