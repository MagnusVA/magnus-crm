"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import {
	CalendarDaysIcon,
	ClockIcon,
	ExternalLinkIcon,
	TagIcon,
} from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
	getReminderUrgency,
	type ReminderUrgency,
} from "../../../_components/reminder-urgency";
import {
	opportunityStatusConfig,
	type OpportunityStatus,
} from "@/lib/status-config";

type Props = {
	followUp: Doc<"followUps">;
	opportunity: Doc<"opportunities">;
	latestMeeting: Doc<"meetings"> | null;
};

/**
 * Friendly label + badge style per urgency bucket. We do NOT rely on
 * colour alone — the label text also changes (`Overdue` vs `Due now`
 * vs `Upcoming`) so the signal is accessible to colour-blind users and
 * screen readers (WCAG 1.4.1).
 */
const URGENCY_BADGE: Record<
	ReminderUrgency,
	{ label: string; className: string }
> = {
	normal: {
		label: "Upcoming",
		className:
			"bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
	},
	amber: {
		label: "Due now",
		className:
			"bg-amber-500/10 text-amber-700 border-amber-200 dark:text-amber-400 dark:border-amber-900",
	},
	red: {
		label: "Overdue",
		className:
			"bg-red-500/10 text-red-700 border-red-200 dark:text-red-400 dark:border-red-900",
	},
};

/**
 * Map the schema's `reason` literal to a friendly label. Kept local —
 * only two consumers exist today (dashboard card uses raw labels via a
 * different code path), and YAGNI until a third appears.
 */
function humaniseReason(reason: Doc<"followUps">["reason"]): string {
	switch (reason) {
		case "closer_initiated":
			return "Closer set this reminder manually";
		case "cancellation_follow_up":
			return "Follow-up after cancellation";
		case "no_show_follow_up":
			return "Follow-up after no-show";
		case "admin_initiated":
			return "Admin created this reminder";
		case "overran_review_resolution":
			return "Created while resolving an overran review";
		case "stale_opportunity_nudge":
			return "System nudge for a stale side-deal opportunity";
	}
}

/**
 * Reminder Metadata Card (Phase 4D)
 *
 * Secondary card beneath the contact card. Answers "what is this about,
 * and how urgent?" at a glance:
 *   - Scheduled time (absolute + relative)
 *   - Urgency badge that re-computes client-side every 30 seconds so
 *     the status escalates live while the closer is reading the page
 *     (same 30s tick the dashboard uses — see reminders-section.tsx)
 *   - Reason (humanised)
 *   - Related meeting link (when `latestMeeting` is present)
 *   - Opportunity status (uses the shared status-config for consistent
 *     labels across every status surface in the app)
 *
 * Visual weight lives on the contact card above; this card is intentionally
 * dense and quiet to avoid competing for attention.
 */
export function ReminderMetadataCard({
	followUp,
	opportunity,
	latestMeeting,
}: Props) {
	// Live urgency tick. We only re-render if the computed urgency
	// *changed* — setInterval firing every 30s costs ~nothing and the
	// badge label will never flip mid-second.
	const scheduledAt = followUp.reminderScheduledAt ?? null;
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!scheduledAt) return;
		const interval = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(interval);
	}, [scheduledAt]);

	const urgency = scheduledAt ? getReminderUrgency(scheduledAt, now) : null;
	const urgencyConfig = urgency ? URGENCY_BADGE[urgency] : null;

	const scheduledAbsolute = scheduledAt
		? format(new Date(scheduledAt), "EEEE, MMMM d · h:mm a")
		: null;
	const scheduledRelative = scheduledAt
		? formatDistanceToNow(new Date(scheduledAt), { addSuffix: true })
		: null;

	const statusKey = opportunity.status as OpportunityStatus;
	const statusConfig = opportunityStatusConfig[statusKey];

	return (
		<Card>
			<CardHeader>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<CardTitle className="text-base">Reminder</CardTitle>
					{urgencyConfig && (
						<Badge
							variant="secondary"
							className={cn(urgencyConfig.className)}
							aria-label={`Urgency: ${urgencyConfig.label}`}
						>
							{urgencyConfig.label}
						</Badge>
					)}
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{/* Scheduled at — absolute time stays stable between renders,
				    relative phrase refreshes with the 30s tick. */}
				{scheduledAbsolute && scheduledRelative && (
					<InfoRow icon={<CalendarDaysIcon />} label="Scheduled">
						<p className="text-sm font-medium tabular-nums">
							{scheduledAbsolute}
						</p>
						<p className="text-muted-foreground text-xs">
							{scheduledRelative}
						</p>
					</InfoRow>
				)}

				{/* Reason — schema guarantees this is a known literal, so
				    humaniseReason has total coverage and no default branch. */}
				<InfoRow icon={<TagIcon />} label="Reason">
					<p className="text-sm">{humaniseReason(followUp.reason)}</p>
				</InfoRow>

				{/* Related meeting — render only when present. `next/link`
				    preserves right-click-open-in-new-tab semantics that a
				    router.push onClick would break. */}
				{latestMeeting && (
					<InfoRow icon={<ClockIcon />} label="Related meeting">
						<Link
							href={`/workspace/closer/meetings/${latestMeeting._id}`}
							className="text-primary inline-flex items-center gap-1 text-sm hover:underline"
						>
							View meeting
							<ExternalLinkIcon className="size-3" />
						</Link>
					</InfoRow>
				)}

				<Separator />

				{/* Opportunity status line — uses the shared config so the
				    label matches every other surface (pipeline, dashboard,
				    calendar). Falls back to the raw key if a migration adds
				    a new status before the config is updated. */}
				<div className="text-muted-foreground flex items-center justify-between text-xs">
					<span className="uppercase tracking-wide">Opportunity</span>
					<Badge
						variant="outline"
						className={cn("text-xs", statusConfig?.badgeClass)}
					>
						{statusConfig?.label ?? opportunity.status.replace(/_/g, " ")}
					</Badge>
				</div>
			</CardContent>
		</Card>
	);
}

// ─── Internal ────────────────────────────────────────────────────────────────

/**
 * Mirrors the `InfoRow` on the meeting detail page (meeting-info-panel.tsx)
 * so these two cards read the same way visually — icon + uppercase label
 * + content block.
 */
function InfoRow({
	icon,
	label,
	children,
}: {
	icon: React.ReactNode;
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-start gap-3">
			<div className="text-muted-foreground mt-0.5 [&>svg]:size-4">
				{icon}
			</div>
			<div className="min-w-0 flex-1">
				<p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
					{label}
				</p>
				{children}
			</div>
		</div>
	);
}
