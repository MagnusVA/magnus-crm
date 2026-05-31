"use client";

import type { EntityAttributionPayload } from "@/convex/lib/attribution/detailPayload";
import { formatDateTime } from "./entity-detail-formatters";

export function EntityAttributionGrid({
	attribution,
}: {
	attribution: EntityAttributionPayload;
}) {
	const fields = [
		["Slack", attribution.slackQualification?.slackUserLabel ?? "Not qualified"],
		["Booked", attribution.bookedProgram?.name ?? "Unmapped"],
		["Sold", attribution.soldProgram?.name ?? "No payment"],
		[
			"DM Team",
			attribution.dmAttribution.teamName ??
				attribution.dmAttribution.rawSource ??
				"None",
		],
		[
			"DM Closer",
			attribution.dmAttribution.dmCloserName ??
				attribution.dmAttribution.rawMedium ??
				"None",
		],
		["Phone", attribution.phoneCloser?.name ?? "Unassigned"],
		["First Meeting", formatDateTime(attribution.timeline.firstMeetingAt)],
		["Payment", formatDateTime(attribution.timeline.paymentReceivedAt)],
	] as const;

	return (
		<dl className="grid gap-2 rounded-md bg-muted/35 p-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
			{fields.map(([key, value]) => (
				<div key={key} className="min-w-0">
					<dt className="truncate text-xs text-muted-foreground">{key}</dt>
					<dd className="truncate font-medium">{value}</dd>
				</div>
			))}
		</dl>
	);
}
