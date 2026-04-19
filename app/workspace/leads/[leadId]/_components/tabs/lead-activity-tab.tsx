"use client";

import {
	CalendarIcon,
	GitMergeIcon,
	MailIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Doc } from "@/convex/_generated/dataModel";

type LeadDetailMeeting = Doc<"meetings"> & {
	opportunityStatus: string;
	closerName: string | null;
};

type LeadMergeHistoryEntry = Doc<"leadMergeHistory"> & {
	mergedByUserName: string;
	sourceLeadName: string;
	targetLeadName: string;
};

interface LeadActivityTabProps {
	meetings: LeadDetailMeeting[];
	followUps: Doc<"followUps">[];
	mergeHistory: LeadMergeHistoryEntry[];
}

type TimelineEntry =
	| { kind: "meeting"; timestamp: number; data: LeadDetailMeeting }
	| { kind: "followUp"; timestamp: number; data: Doc<"followUps"> }
	| { kind: "merge"; timestamp: number; data: LeadMergeHistoryEntry };

function buildTimeline(
	meetings: LeadDetailMeeting[],
	followUps: Doc<"followUps">[],
	mergeHistory: LeadMergeHistoryEntry[],
): TimelineEntry[] {
	const entries: TimelineEntry[] = [];

	for (const meeting of meetings) {
		entries.push({
			kind: "meeting",
			timestamp: meeting.scheduledAt,
			data: meeting,
		});
	}

	for (const followUp of followUps) {
		entries.push({
			kind: "followUp",
			timestamp: followUp.createdAt,
			data: followUp,
		});
	}

	for (const merge of mergeHistory) {
		entries.push({
			kind: "merge",
			timestamp: merge.mergedAt,
			data: merge,
		});
	}

	return entries.sort((a, b) => b.timestamp - a.timestamp);
}

const iconConfig = {
	meeting: {
		icon: CalendarIcon,
		bg: "bg-blue-500/10",
		text: "text-blue-600 dark:text-blue-400",
		line: "bg-blue-200 dark:bg-blue-900",
	},
	followUp: {
		icon: MailIcon,
		bg: "bg-violet-500/10",
		text: "text-violet-600 dark:text-violet-400",
		line: "bg-violet-200 dark:bg-violet-900",
	},
	merge: {
		icon: GitMergeIcon,
		bg: "bg-amber-500/10",
		text: "text-amber-600 dark:text-amber-400",
		line: "bg-amber-200 dark:bg-amber-900",
	},
};

function formatTimestamp(ts: number): string {
	return new Date(ts).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function MeetingEntry({ meeting }: { meeting: LeadDetailMeeting }) {
	return (
		<div>
			<p className="text-sm font-medium">
				Meeting{meeting.closerName ? ` with ${meeting.closerName}` : ""}
			</p>
			<p className="text-xs text-muted-foreground">
				Status: {meeting.opportunityStatus.replace(/_/g, " ")}
				{meeting.status && meeting.status !== meeting.opportunityStatus
					? ` / Meeting: ${meeting.status.replace(/_/g, " ")}`
					: ""}
			</p>
		</div>
	);
}

function FollowUpEntry({ followUp }: { followUp: Doc<"followUps"> }) {
	const reasonLabels: Record<string, string> = {
		closer_initiated: "Closer initiated",
		cancellation_follow_up: "Cancellation follow-up",
		no_show_follow_up: "No-show follow-up",
		admin_initiated: "Admin initiated",
		overran_review_resolution: "Overran review resolution",
	};

	return (
		<div>
			<p className="text-sm font-medium">
				Follow-up ({followUp.status})
			</p>
			<p className="text-xs text-muted-foreground">
				{reasonLabels[followUp.reason] ?? followUp.reason}
				{followUp.reminderNote ? ` -- ${followUp.reminderNote}` : ""}
			</p>
		</div>
	);
}

function MergeEntry({ merge }: { merge: LeadMergeHistoryEntry }) {
	return (
		<div>
			<p className="text-sm font-medium">
				Lead merged: {merge.sourceLeadName} into {merge.targetLeadName}
			</p>
			<p className="text-xs text-muted-foreground">
				By {merge.mergedByUserName}
				{merge.meetingsMoved > 0 &&
					` -- ${merge.meetingsMoved} meeting${merge.meetingsMoved === 1 ? "" : "s"} moved`}
				{merge.identifiersMoved > 0 &&
					`, ${merge.identifiersMoved} identifier${merge.identifiersMoved === 1 ? "" : "s"} moved`}
				{merge.opportunitiesMoved > 0 &&
					`, ${merge.opportunitiesMoved} opportunit${merge.opportunitiesMoved === 1 ? "y" : "ies"} moved`}
			</p>
		</div>
	);
}

export function LeadActivityTab({
	meetings,
	followUps,
	mergeHistory,
}: LeadActivityTabProps) {
	const timeline = buildTimeline(meetings, followUps, mergeHistory);

	if (timeline.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-12">
				<p className="text-sm text-muted-foreground">
					No activity recorded for this lead.
				</p>
			</div>
		);
	}

	return (
		<div className="relative">
			{timeline.map((entry, index) => {
				const config = iconConfig[entry.kind];
				const Icon = config.icon;
				const isLast = index === timeline.length - 1;

				return (
					<div key={`${entry.kind}-${index}`} className="relative flex gap-4 pb-6 last:pb-0">
						{/* Vertical connector line */}
						{!isLast && (
							<div
								className={cn(
									"absolute left-[17px] top-10 h-[calc(100%-28px)] w-0.5",
									config.line,
								)}
							/>
						)}

						{/* Icon */}
						<div
							className={cn(
								"relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
								config.bg,
							)}
						>
							<Icon className={cn("h-4 w-4", config.text)} />
						</div>

						{/* Content */}
						<div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-1">
							{entry.kind === "meeting" && (
								<MeetingEntry meeting={entry.data} />
							)}
							{entry.kind === "followUp" && (
								<FollowUpEntry followUp={entry.data} />
							)}
							{entry.kind === "merge" && <MergeEntry merge={entry.data} />}

							<time
								dateTime={new Date(entry.timestamp).toISOString()}
								className="text-xs text-muted-foreground"
							>
								{formatTimestamp(entry.timestamp)}
							</time>
						</div>
					</div>
				);
			})}
		</div>
	);
}
