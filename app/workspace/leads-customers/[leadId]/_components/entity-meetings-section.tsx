"use client";

import { useMemo } from "react";
import { CalendarClockIcon } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import {
	LabelWithInfoTooltip,
	leadsCustomersTooltips,
} from "../../_components/entity-ui-tooltips";
import { useEntityDetail } from "./entity-detail-context";
import { EntityMeetingRow } from "./entity-meeting-row";
import { SectionShell } from "./entity-detail-ui";

export function EntityMeetingsSection() {
	const { meetings, comments, caps } = useEntityDetail();
	const commentsByMeetingId = useMemo(() => {
		const grouped = new Map<Id<"meetings">, typeof comments>();
		for (const comment of comments) {
			const existing = grouped.get(comment.meetingId) ?? [];
			existing.push(comment);
			grouped.set(comment.meetingId, existing);
		}
		return grouped;
	}, [comments]);

	return (
		<SectionShell
			title="Meetings"
			icon={<CalendarClockIcon aria-hidden="true" />}
			count={meetings.length || undefined}
			meta={
				caps.meetings ? (
					<LabelWithInfoTooltip
						label="Latest 50"
						description={leadsCustomersTooltips.listCap("50 meetings")}
					/>
				) : null
			}
			bodyClassName="divide-y divide-border/60"
		>
			{meetings.length === 0 ? (
				<div className="p-4 text-sm text-muted-foreground">No meetings found.</div>
			) : (
				meetings.map((meeting) => (
					<EntityMeetingRow
						key={meeting._id}
						meeting={meeting}
						comments={commentsByMeetingId.get(meeting._id) ?? []}
					/>
				))
			)}
		</SectionShell>
	);
}
