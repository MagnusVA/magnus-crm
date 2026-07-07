"use client";

import { useQuery } from "convex/react";
import { MessageSquareTextIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useEntityDetail } from "./entity-detail-context";
import { formatDateTime } from "./entity-detail-formatters";
import { SectionShell } from "./entity-detail-ui";

/**
 * Lead notes written by DM closers in the link portal (NIM-17 Phase 5).
 * Read-only here; deliberately kept separate from meeting comments.
 */
export function EntityPortalNotesSection() {
	const { lead } = useEntityDetail();
	const notes = useQuery(api.leads.notes.listLeadNotes, { leadId: lead._id });

	return (
		<SectionShell
			title="Portal Notes"
			icon={<MessageSquareTextIcon aria-hidden="true" />}
			count={notes?.length || undefined}
			bodyClassName="p-4"
		>
			{notes === undefined ? (
				<div
					role="status"
					aria-label="Loading portal notes"
					className="flex flex-col gap-3"
				>
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			) : notes.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					No notes yet — DM closers can add notes from the link portal.
				</p>
			) : (
				<ol className="flex flex-col gap-3.5">
					{notes.map((note) => (
						<li key={note.noteId} className="flex min-w-0 flex-col gap-0.5">
							<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
								<span className="text-sm font-medium" translate="no">
									{note.authorLabel}
								</span>
								<Badge variant="outline" className="text-[10px]">
									{note.authorKind === "dm_closer" ? "DM closer" : "Team"}
								</Badge>
								<time
									className="text-[11px] text-muted-foreground tabular-nums"
									dateTime={new Date(note.createdAt).toISOString()}
								>
									{formatDateTime(note.createdAt)}
								</time>
							</div>
							<p
								className="text-sm whitespace-pre-wrap wrap-break-word"
								translate="no"
							>
								{note.content}
							</p>
						</li>
					))}
				</ol>
			)}
		</SectionShell>
	);
}
