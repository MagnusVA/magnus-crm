"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import type { EntityDetailComment } from "./entity-detail-context";
import { formatDateTime } from "./entity-detail-formatters";

export function EntityCommentsList({
	meetingId,
	comments,
}: {
	meetingId: Id<"meetings">;
	comments: EntityDetailComment[];
}) {
	const [open, setOpen] = useState(false);

	if (comments.length === 0) return null;

	const panelId = `meeting-comments-${meetingId}`;
	const label =
		comments.length === 1 ? "1 comment" : `${comments.length} comments`;

	return (
		<div className="mt-3 ml-5 flex flex-col gap-2">
			<button
				type="button"
				onClick={() => setOpen((prev) => !prev)}
				aria-expanded={open}
				aria-controls={panelId}
				className="group/disc flex w-fit items-center gap-1 rounded-sm text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			>
				<ChevronRightIcon
					aria-hidden="true"
					className={cn(
						"size-3.5 transition-transform",
						open && "rotate-90",
					)}
				/>
				{label}
			</button>
			{open ? (
				<div
					id={panelId}
					className="flex flex-col gap-3 border-l border-border/70 pl-3.5"
				>
					{comments.map((comment) => (
						<div key={comment._id} className="text-sm">
							<time
								className="text-[11px] text-muted-foreground tabular-nums"
								dateTime={new Date(comment.createdAt).toISOString()}
							>
								{formatDateTime(comment.createdAt)}
							</time>
							<p className="mt-1 wrap-break-word whitespace-pre-wrap" translate="no">
								{comment.content}
							</p>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
