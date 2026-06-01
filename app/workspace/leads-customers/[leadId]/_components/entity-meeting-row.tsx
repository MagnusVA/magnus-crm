"use client";

import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import { useRole } from "@/components/auth/role-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
	EntityDetailComment,
	EntityDetailMeeting,
} from "./entity-detail-context";
import {
	leadsCustomersTooltips,
	SimpleTooltip,
} from "../../_components/entity-ui-tooltips";
import { EntityCommentsList } from "./entity-comments-list";
import { formatDateTime, formatToken } from "./entity-detail-formatters";
import { MetaDot, MetaRow } from "./entity-detail-ui";
import { meetingDetailHref } from "./meeting-link-utils";

const MEETING_DOT_CLASS: Record<string, string> = {
	scheduled: "bg-blue-500",
	completed: "bg-emerald-500",
	no_show: "bg-orange-500",
	canceled: "bg-muted-foreground",
};

export function EntityMeetingRow({
	meeting,
	comments,
}: {
	meeting: EntityDetailMeeting;
	comments: EntityDetailComment[];
}) {
	const { role } = useRole();
	const href = meetingDetailHref({ meetingId: meeting._id, viewerRole: role });

	return (
		<div className="py-3 pr-3 pl-4 transition-colors hover:bg-muted/30">
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 gap-3">
					<SimpleTooltip content={`Meeting ${formatToken(meeting.status)}`}>
						<span
							aria-hidden="true"
							className={cn(
								"mt-1.5 size-2 shrink-0 rounded-full",
								MEETING_DOT_CLASS[meeting.status] ?? "bg-muted-foreground",
							)}
						/>
					</SimpleTooltip>
					<div className="flex min-w-0 flex-col gap-1.5">
						<div className="flex flex-wrap items-center gap-1.5">
							<SimpleTooltip content="Meeting lifecycle status">
								<Badge variant="secondary">{formatToken(meeting.status)}</Badge>
							</SimpleTooltip>
							{meeting.callClassification ? (
								<SimpleTooltip content={leadsCustomersTooltips.meetingClassification}>
									<Badge variant="outline">
										{formatToken(meeting.callClassification)}
									</Badge>
								</SimpleTooltip>
							) : null}
							<span className="text-sm font-medium tabular-nums">
								{formatDateTime(meeting.scheduledAt)}
							</span>
						</div>
						<MetaRow>
							<span className="tabular-nums">{meeting.durationMinutes} min</span>
							<MetaDot />
							<span className="truncate" translate="no">
								{meeting.bookingProgramName ?? "Program not mapped"}
							</span>
							{meeting.soldProgramName ? (
								<>
									<MetaDot />
									<span className="truncate" translate="no">
										Sold {meeting.soldProgramName}
									</span>
								</>
							) : null}
						</MetaRow>
					</div>
				</div>
				{meeting.permissions.canOpenMeeting ? (
					<SimpleTooltip content={leadsCustomersTooltips.openMeeting}>
						<Button asChild variant="ghost" size="sm" className="shrink-0">
							<Link href={href} target="_blank" rel="noreferrer">
								Open
								<ExternalLinkIcon data-icon="inline-end" aria-hidden="true" />
							</Link>
						</Button>
					</SimpleTooltip>
				) : null}
			</div>
			<EntityCommentsList comments={comments} />
		</div>
	);
}
