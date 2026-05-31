"use client";

import { useMemo } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { useEntityDetail } from "./entity-detail-context";
import { EntityMeetingRow } from "./entity-meeting-row";

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
		<section className="rounded-md border">
			<div className="flex items-center justify-between gap-3 border-b p-3">
				<h2 className="text-sm font-semibold">Meetings</h2>
				{caps.meetings ? (
					<span className="text-xs text-muted-foreground">Showing latest 50</span>
				) : null}
			</div>
			{meetings.length === 0 ? (
				<div className="p-4 text-sm text-muted-foreground">No meetings found.</div>
			) : (
				<div className="divide-y">
					{meetings.map((meeting) => (
						<EntityMeetingRow
							key={meeting._id}
							meeting={meeting}
							comments={commentsByMeetingId.get(meeting._id) ?? []}
						/>
					))}
				</div>
			)}
		</section>
	);
}
