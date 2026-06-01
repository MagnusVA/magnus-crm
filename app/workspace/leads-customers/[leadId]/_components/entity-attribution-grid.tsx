"use client";

import type { EntityAttributionPayload } from "@/convex/lib/attribution/detailPayload";
import {
	LabelWithInfoTooltip,
	TruncatingTooltip,
} from "../../_components/entity-ui-tooltips";
import { formatDateTime } from "./entity-detail-formatters";

const attributionFieldHelp: Record<string, string> = {
	Slack: "Slack user who qualified this opportunity, if applicable.",
	Booked: "Program mapped from the first Calendly booking.",
	Sold: "Program recorded on the closed payment, if any.",
	"DM Team": "DM attribution team from UTM or mapped team.",
	"DM Closer": "DM closer credited from UTM or mapped closer.",
	Phone: "Phone closer assigned to run the sales call.",
	"First Meeting": "When the first meeting on this opportunity was scheduled.",
	Payment: "When payment was first received on this opportunity.",
};

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
		<dl className="grid gap-x-4 gap-y-2.5 rounded-lg border border-border/60 bg-muted/30 p-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
			{fields.map(([key, value]) => (
				<div key={key} className="flex min-w-0 flex-col gap-0.5">
					<dt className="truncate">
						<LabelWithInfoTooltip
							label={key}
							description={attributionFieldHelp[key]}
							className="text-[10px] font-medium tracking-[0.09em] text-muted-foreground uppercase"
						/>
					</dt>
					<TruncatingTooltip content={value}>
						<dd className="truncate text-xs font-medium" translate="no">
							{value}
						</dd>
					</TruncatingTooltip>
				</div>
			))}
		</dl>
	);
}
