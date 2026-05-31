"use client";

import { useEntityDetail } from "./entity-detail-context";
import { formatDateTime, formatMoneyMinor, formatToken } from "./entity-detail-formatters";

function activityLabel(event: ReturnType<typeof useEntityDetail>["activity"][number]) {
	if (event.kind === "payment") {
		return `Payment ${formatMoneyMinor(event.amountMinor, event.currency)}`;
	}
	if (event.kind === "customer") {
		return `Customer ${formatToken(event.status)}`;
	}
	if (event.kind === "meeting") {
		return `Meeting ${formatToken(event.status)}`;
	}
	return `Opportunity ${formatToken(event.status)}`;
}

export function EntityActivitySection() {
	const { activity, caps } = useEntityDetail();

	return (
		<section className="rounded-md border">
			<div className="flex items-center justify-between gap-3 border-b p-3">
				<h2 className="text-sm font-semibold">Activity</h2>
				{caps.activity ? (
					<span className="text-xs text-muted-foreground">
						Showing latest {caps.maxActivity}
					</span>
				) : null}
			</div>
			{activity.length === 0 ? (
				<div className="p-4 text-sm text-muted-foreground">No activity yet.</div>
			) : (
				<div className="divide-y">
					{activity.map((event) => (
						<div
							key={`${event.kind}:${event.at}`}
							className="grid gap-1 p-3 text-sm sm:grid-cols-[11rem_1fr]"
						>
							<div className="text-muted-foreground tabular-nums">
								{formatDateTime(event.at)}
							</div>
							<div className="font-medium">{activityLabel(event)}</div>
						</div>
					))}
				</div>
			)}
		</section>
	);
}
