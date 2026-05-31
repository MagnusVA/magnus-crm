"use client";

import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import { useRole } from "@/components/auth/role-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
	EntityDetailComment,
	EntityDetailMeeting,
} from "./entity-detail-context";
import { EntityCommentsList } from "./entity-comments-list";
import { formatDateTime, formatToken } from "./entity-detail-formatters";
import { meetingDetailHref } from "./meeting-link-utils";

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
		<div className="p-3 text-sm">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant="secondary">{formatToken(meeting.status)}</Badge>
						{meeting.callClassification ? (
							<Badge variant="outline">
								{formatToken(meeting.callClassification)}
							</Badge>
						) : null}
						<Badge variant="outline">{formatToken(meeting.opportunityStatus)}</Badge>
					</div>
					<div className="mt-1 font-medium tabular-nums">
						{formatDateTime(meeting.scheduledAt)}
					</div>
					<div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
						<span>{meeting.durationMinutes} min</span>
						<span>{meeting.bookingProgramName ?? "Program not mapped"}</span>
						{meeting.soldProgramName ? <span>{meeting.soldProgramName}</span> : null}
					</div>
				</div>
				{meeting.permissions.canOpenMeeting ? (
					<Button asChild variant="ghost" size="sm" className="shrink-0">
						<Link
							href={href}
							target="_blank"
							rel="noreferrer"
						>
							Open Meeting
							<ExternalLinkIcon data-icon="inline-end" aria-hidden="true" />
						</Link>
					</Button>
				) : null}
			</div>
			<EntityCommentsList comments={comments} />
		</div>
	);
}
