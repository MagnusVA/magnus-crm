"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import {
	Card,
	CardAction,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { BellIcon, PhoneIcon, MessageSquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	getReminderUrgency,
	type ReminderUrgency,
} from "./reminder-urgency";

const TICK_INTERVAL_MS = 30_000;

type EnrichedReminder = FunctionReturnType<
	typeof api.closer.followUpQueries.getActiveReminders
>[number];

/**
 * Reminders panel — single card with a scrollable list of active reminders
 * on the closer dashboard.
 *
 * Phase 6 of the reminder-outcomes feature retired the embedded completion
 * dialog that used to live here. Clicking a row now navigates to the
 * dedicated `/workspace/closer/reminders/[followUpId]` detail page (Phase 4),
 * which owns the three outcome paths (Phase 5). This component is now a
 * pure list view — it queries reminders, runs a 30s urgency tick, and
 * routes on click.
 *
 * Why keep the 30s tick?
 *   - Each row's badge colour, label, and background tint depend on the
 *     `ReminderUrgency` bucket (`normal` / `amber` / `red`). The tick
 *     re-renders the list so urgency escalates live while the closer is
 *     scanning the dashboard.
 */
export function RemindersSection() {
	const reminders = useQuery(api.closer.followUpQueries.getActiveReminders);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const interval = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
		return () => clearInterval(interval);
	}, []);

	if (!reminders || reminders.length === 0) return null;

	return (
		<Card className="flex flex-col">
			<CardHeader>
				<div className="flex items-center gap-2">
					<BellIcon className="text-muted-foreground size-4" />
					<CardTitle>Reminders</CardTitle>
				</div>
				<CardAction>
					<Badge variant="secondary">{reminders.length}</Badge>
				</CardAction>
			</CardHeader>
			<CardContent className="flex-1 p-0">
				<div className="max-h-[280px] overflow-y-auto">
					{reminders.map((reminder, index) => {
						const urgency = getReminderUrgency(
							reminder.reminderScheduledAt ?? 0,
							now,
						);
						return (
							<div key={reminder._id}>
								{index > 0 && <Separator />}
								<ReminderListItem
									reminder={reminder}
									urgency={urgency}
									href={
										reminder.reason === "stale_opportunity_nudge"
											? `/workspace/opportunities/${reminder.opportunityId}`
											: `/workspace/closer/reminders/${reminder._id}`
									}
								/>
							</div>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}

/**
 * Compact list row for a single reminder. Clicking the row navigates to
 * the dedicated reminder detail page — the row itself carries no outcome
 * state beyond the visual urgency tint.
 */
function ReminderListItem({
	reminder,
	urgency,
	href,
}: {
	reminder: EnrichedReminder;
	urgency: ReminderUrgency;
	href: string;
}) {
	const isStaleNudge = reminder.reason === "stale_opportunity_nudge";
	const MethodIcon = isStaleNudge
		? BellIcon
		: reminder.contactMethod === "text"
			? MessageSquareIcon
			: PhoneIcon;
	const urgencyLabel =
		urgency === "red" ? "Overdue" : urgency === "amber" ? "Now" : "Due";
	const methodLabel = isStaleNudge
		? "Review"
		: reminder.contactMethod === "text"
			? "Text"
			: "Call";
	const statusLabel = isStaleNudge ? "Stale" : urgencyLabel;

	return (
		<Link
			href={href}
			aria-label={
				isStaleNudge
					? `Open stale opportunity for ${reminder.leadName}`
					: `Open reminder for ${reminder.leadName}`
			}
			className={cn(
				"hover:bg-accent focus-visible:ring-ring flex w-full items-center gap-3 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset",
				urgency === "red" && "bg-red-50 dark:bg-red-950/20",
				urgency === "amber" && "bg-amber-50 dark:bg-amber-950/20",
			)}
		>
			{/* Urgency dot — redundant with the badge text, but provides a
			    fast visual scan channel for sighted users. */}
			<span
				className={cn(
					"size-2 shrink-0 rounded-full",
					urgency === "red" && "bg-red-500",
					urgency === "amber" && "bg-amber-500",
					urgency === "normal" && "bg-muted-foreground/40",
				)}
				aria-hidden="true"
			/>

			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium">{reminder.leadName}</p>
				{reminder.reminderScheduledAt && (
					<p className="text-muted-foreground text-xs">
						{new Date(reminder.reminderScheduledAt).toLocaleString([], {
							dateStyle: "short",
							timeStyle: "short",
						})}
					</p>
				)}
			</div>

			<Badge
				variant={
					isStaleNudge
						? "outline"
						: urgency === "red"
						? "destructive"
						: urgency === "amber"
							? "outline"
							: "secondary"
				}
				className="shrink-0"
			>
				<MethodIcon className="mr-1 size-3" />
				{methodLabel}
				{" · "}
				{statusLabel}
			</Badge>
		</Link>
	);
}
