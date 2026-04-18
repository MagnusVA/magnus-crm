"use client";

import { format } from "date-fns";
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
	meetingStatusConfig,
	type MeetingStatus,
} from "@/lib/status-config";

type Props = {
	latestMeeting: Doc<"meetings"> | null;
	payments: Doc<"paymentRecords">[];
};

/**
 * Per-meeting-status badge classes, mirroring the subtle palette the
 * meeting-info-panel uses so the two surfaces read the same. Kept local
 * to this panel because the shared config exposes the bolder calendar
 * `blockClass` tokens which don't suit inline history rows.
 */
const MEETING_BADGE_CLASS: Record<MeetingStatus, string> = {
	scheduled:
		"bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
	in_progress:
		"bg-amber-500/10 text-amber-700 border-amber-200 dark:text-amber-400 dark:border-amber-900",
	completed:
		"bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900",
	canceled: "bg-muted text-muted-foreground border-border",
	no_show:
		"bg-orange-500/10 text-orange-700 border-orange-200 dark:text-orange-400 dark:border-orange-900",
	meeting_overran:
		"bg-yellow-500/10 text-yellow-700 border-yellow-200 dark:text-yellow-400 dark:border-yellow-900",
};

/**
 * Reminder History Panel (Phase 4E)
 *
 * Left-column contextual card that answers two questions closers ask
 * right before picking up the phone:
 *
 *   1. "What was the last meeting — did they no-show? Cancel?"
 *   2. "Have we already taken a deposit on this opportunity?"
 *
 * Rendering rules:
 *   - If both sections are empty, we render a single muted line rather
 *     than hiding the card entirely. Hiding it would cause layout shift
 *     when the reminder is new (no meeting yet, no payments yet).
 *   - Payment list is capped in the backing query (`.take(10)` — see
 *     `convex/closer/reminderDetail.ts`). MVP accepts the truncation.
 *   - No pagination, no filtering: this panel is a snapshot, not a log.
 */
export function ReminderHistoryPanel({ latestMeeting, payments }: Props) {
	const hasContent = latestMeeting !== null || payments.length > 0;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">History</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{/* Latest meeting */}
				<section>
					<p className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">
						Latest meeting
					</p>
					{latestMeeting ? (
						<LatestMeetingRow meeting={latestMeeting} />
					) : (
						<p className="text-muted-foreground text-sm">
							No prior meetings on this opportunity.
						</p>
					)}
				</section>

				{payments.length > 0 && (
					<>
						<Separator />
						<section>
							<p className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">
								Payments ({payments.length})
							</p>
							<ul className="flex flex-col gap-1.5">
								{payments.map((payment) => (
									<PaymentRow key={payment._id} payment={payment} />
								))}
							</ul>
						</section>
					</>
				)}

				{/* Graceful tail for the edge case: no meeting, no payments.
				    Extremely rare for a reminder (it almost always hangs off
				    a meeting) but schema-legal after a closer-initiated
				    reminder on a brand-new opportunity. */}
				{!hasContent && (
					<p className="text-muted-foreground text-xs italic">
						No activity recorded yet.
					</p>
				)}
			</CardContent>
		</Card>
	);
}

// ─── Internal ────────────────────────────────────────────────────────────────

function LatestMeetingRow({ meeting }: { meeting: Doc<"meetings"> }) {
	const statusKey = meeting.status as MeetingStatus;
	const statusCfg = meetingStatusConfig[statusKey];
	const when = format(new Date(meeting.scheduledAt), "MMM d · h:mm a");

	return (
		<div className="flex items-center justify-between gap-2">
			<div className="min-w-0">
				<p className="text-sm font-medium tabular-nums">{when}</p>
				<p className="text-muted-foreground text-xs">
					{meeting.durationMinutes} min
				</p>
			</div>
			<Badge
				variant="outline"
				className={cn(MEETING_BADGE_CLASS[statusKey])}
			>
				{statusCfg?.label ?? meeting.status.replace(/_/g, " ")}
			</Badge>
		</div>
	);
}

function PaymentRow({ payment }: { payment: Doc<"paymentRecords"> }) {
	// `amountMinor` stores integer cents (Convex monetary convention).
	// `.toFixed(2)` gives us the display decimal; we avoid `Intl.NumberFormat`
	// because it injects locale-specific thousand separators that don't match
	// the rest of the meeting-detail payment UI.
	const amount = (payment.amountMinor / 100).toFixed(2);
	// `recordedAt` is required on the schema but _creationTime is always
	// available as a fallback, preserved from the extraction pattern used
	// in the meeting detail page.
	const date = format(
		new Date(payment.recordedAt ?? payment._creationTime),
		"MMM d",
	);

	return (
		<li className="flex items-center justify-between text-sm tabular-nums">
			<span className="text-muted-foreground">{date}</span>
			<span className="font-medium">
				{amount} {payment.currency.toUpperCase()}
			</span>
		</li>
	);
}
