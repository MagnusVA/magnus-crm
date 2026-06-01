"use client";

import type { EntityDetailComment } from "./entity-detail-context";
import { formatDateTime } from "./entity-detail-formatters";

export function EntityCommentsList({
	comments,
}: {
	comments: EntityDetailComment[];
}) {
	if (comments.length === 0) return null;

	return (
		<div className="mt-3 ml-5 flex flex-col gap-3 border-l border-border/70 pl-3.5">
			<div className="text-[10px] font-medium tracking-[0.09em] text-muted-foreground uppercase">
				Comments
			</div>
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
	);
}
