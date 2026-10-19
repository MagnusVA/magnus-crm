"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { ActivityIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useEntityDetail } from "./entity-detail-context";
import { formatDateTime } from "./entity-detail-formatters";
import { SectionShell } from "./entity-detail-ui";

const PAGE_SIZE = 100;

// The person's timeline: every touch and change, from the event log
// (docs/plans/phase-2-person-first.md §6.1).
function dotClass(eventType: string) {
	if (eventType.startsWith("payment.") || eventType.startsWith("customer.")) {
		return "bg-emerald-500";
	}
	if (eventType.startsWith("meeting.") || eventType.startsWith("followUp.")) {
		return "bg-blue-500";
	}
	if (eventType.startsWith("opportunity.")) {
		return "bg-violet-500";
	}
	if (
		eventType === "lead.captured" ||
		eventType.startsWith("lead.portal_") ||
		eventType === "lead.slack_qualified"
	) {
		return "bg-amber-500";
	}
	return "bg-primary";
}

export function EntityActivitySection() {
	const { lead } = useEntityDetail();
	const [limit, setLimit] = useState(PAGE_SIZE);
	const latest = useQuery(api.leadCustomers.timeline.getLeadTimeline, {
		leadId: lead._id,
		limit,
	});
	// Keeps the entries on screen while "Show older" loads a bigger page.
	const [shown, setShown] = useState<{ leadId: string; data: typeof latest }>({
		leadId: lead._id,
		data: undefined,
	});
	if (latest !== undefined && (shown.data !== latest || shown.leadId !== lead._id)) {
		setShown({ leadId: lead._id, data: latest });
	}
	const timeline =
		latest ?? (shown.leadId === lead._id ? shown.data : undefined);
	const entries = timeline?.entries ?? [];

	return (
		<SectionShell
			title="Timeline"
			icon={<ActivityIcon aria-hidden="true" />}
			count={entries.length || undefined}
			bodyClassName="p-4"
		>
			{timeline === undefined ? (
				<div className="flex flex-col gap-3">
					<Skeleton className="h-8 w-full" />
					<Skeleton className="h-8 w-full" />
				</div>
			) : entries.length === 0 ? (
				<div className="text-sm text-muted-foreground">No activity yet.</div>
			) : (
				<div className="flex flex-col gap-3">
					<ol className="relative flex flex-col">
						{entries.map((entry, index) => (
							<li
								key={entry.eventId}
								className="relative grid grid-cols-[auto_1fr] gap-x-3 pb-3.5 last:pb-0"
							>
								{index < entries.length - 1 ? (
									<span
										aria-hidden="true"
										className="absolute top-3 left-[3.5px] h-full w-px bg-border/70"
									/>
								) : null}
								<span
									aria-hidden="true"
									className={cn(
										"relative z-10 mt-1 size-2 shrink-0 rounded-full ring-2 ring-card",
										dotClass(entry.eventType),
									)}
								/>
								<div className="flex min-w-0 flex-col gap-0.5">
									<span className="text-sm font-medium">
										{entry.label}
										{entry.fromStatus || entry.toStatus ? (
											<span className="font-normal text-muted-foreground">
												{" "}
												{entry.fromStatus ? `${entry.fromStatus} → ` : ""}
												{entry.toStatus}
											</span>
										) : null}
									</span>
									<span className="text-[11px] text-muted-foreground tabular-nums">
										<time dateTime={new Date(entry.occurredAt).toISOString()}>
											{formatDateTime(entry.occurredAt)}
										</time>
										{entry.actorName ? ` · ${entry.actorName}` : null}
										{entry.detail ? ` · ${entry.detail}` : null}
									</span>
								</div>
							</li>
						))}
					</ol>
					{timeline?.capped ? (
						<p className="text-xs text-muted-foreground">
							Older events aren&apos;t shown.
						</p>
					) : null}
					{timeline?.hasMore ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="self-start"
							onClick={() => setLimit((current) => current + PAGE_SIZE)}
						>
							Show older
						</Button>
					) : null}
				</div>
			)}
		</SectionShell>
	);
}
