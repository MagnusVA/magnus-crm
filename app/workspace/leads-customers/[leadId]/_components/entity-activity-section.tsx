"use client";

import { ActivityIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	LabelWithInfoTooltip,
	leadsCustomersTooltips,
} from "../../_components/entity-ui-tooltips";
import { useEntityDetail } from "./entity-detail-context";
import {
	formatDateTime,
	formatMoneyMinor,
	formatToken,
} from "./entity-detail-formatters";
import { SectionShell } from "./entity-detail-ui";

type ActivityEvent = ReturnType<typeof useEntityDetail>["activity"][number];

function activityLabel(event: ActivityEvent) {
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

const ACTIVITY_DOT_CLASS: Record<ActivityEvent["kind"], string> = {
	payment: "bg-emerald-500",
	customer: "bg-primary",
	meeting: "bg-blue-500",
	opportunity_status: "bg-violet-500",
};

export function EntityActivitySection() {
	const { activity, caps } = useEntityDetail();

	return (
		<SectionShell
			title="Activity"
			icon={<ActivityIcon aria-hidden="true" />}
			count={activity.length || undefined}
			meta={
				caps.activity ? (
					<LabelWithInfoTooltip
						label={`Latest ${caps.maxActivity}`}
						description={leadsCustomersTooltips.listCap(
							`${caps.maxActivity} activity events`,
						)}
					/>
				) : null
			}
			bodyClassName="p-4"
		>
			{activity.length === 0 ? (
				<div className="text-sm text-muted-foreground">No activity yet.</div>
			) : (
				<ol className="relative flex flex-col">
					{activity.map((event, index) => (
						<li
							key={`${event.kind}:${event.at}`}
							className="relative grid grid-cols-[auto_1fr] gap-x-3 pb-3.5 last:pb-0"
						>
							{index < activity.length - 1 ? (
								<span
									aria-hidden="true"
									className="absolute top-3 left-[3.5px] h-full w-px bg-border/70"
								/>
							) : null}
							<span
								aria-hidden="true"
								className={cn(
									"relative z-10 mt-1 size-2 shrink-0 rounded-full ring-2 ring-card",
									ACTIVITY_DOT_CLASS[event.kind],
								)}
							/>
							<div className="flex min-w-0 flex-col gap-0.5">
								<span className="text-sm font-medium" translate="no">
									{activityLabel(event)}
								</span>
								<time
									className="text-[11px] text-muted-foreground tabular-nums"
									dateTime={new Date(event.at).toISOString()}
								>
									{formatDateTime(event.at)}
								</time>
							</div>
						</li>
					))}
				</ol>
			)}
		</SectionShell>
	);
}
