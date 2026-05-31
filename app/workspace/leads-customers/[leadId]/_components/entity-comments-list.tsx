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
		<div className="mt-3 flex flex-col gap-2 border-l pl-3">
			<div className="text-xs font-medium text-muted-foreground">Comments</div>
			{comments.map((comment) => (
				<div key={comment._id} className="text-sm">
					<div className="text-xs text-muted-foreground tabular-nums">
						{formatDateTime(comment.createdAt)}
					</div>
					<p className="mt-1 whitespace-pre-wrap break-words">{comment.content}</p>
				</div>
			))}
		</div>
	);
}
