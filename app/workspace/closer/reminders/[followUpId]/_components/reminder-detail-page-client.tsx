"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { Preloaded } from "convex/react";
import { usePreloadedQuery } from "convex/react";
import posthog from "posthog-js";
import type { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { ArrowLeftIcon, AlertCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
	EmptyDescription,
} from "@/components/ui/empty";
import { LeadInfoPanel } from "../../../meetings/_components/lead-info-panel";
import { PaymentLinksPanel } from "../../../meetings/_components/payment-links-panel";
import { ReminderContactCard } from "./reminder-contact-card";
import { ReminderMetadataCard } from "./reminder-metadata-card";
import { ReminderHistoryPanel } from "./reminder-history-panel";

/**
 * Phase 5 owns the real `ReminderOutcomeActionBar`. A dynamic import lets
 * Phase 4 ship the page independently — Phase 5 overwrites the file
 * without any change to this import path. `ssr` is left at the default
 * (true) so the action bar is part of the first paint.
 */
const ReminderOutcomeActionBar = dynamic(() =>
	import("./reminder-outcome-action-bar").then((m) => ({
		default: m.ReminderOutcomeActionBar,
	})),
);

/**
 * Reminder Detail Page Client (Phase 4B)
 *
 * Consumes the preloaded `getReminderDetail` query via `usePreloadedQuery`
 * (subscribes to reactive updates so the page live-reacts when any side
 * effect from the outcome mutations lands), sets the page title, and
 * distributes data to five children:
 *
 *   - `LeadInfoPanel`        — reused from the meeting detail page
 *   - `ReminderHistoryPanel` — latest meeting + payments
 *   - `ReminderContactCard`  — tel/sms/copy CTAs, reminder note
 *   - `ReminderMetadataCard` — scheduled time, urgency, reason, meeting link
 *   - `ReminderOutcomeActionBar` (Phase 5) — the three outcome buttons
 *
 * Returns the "Reminder Not Found" empty state when the query returns
 * null (wrong tenant / wrong closer / missing / wrong follow-up type) —
 * design doc §14.1. No data leak across these cases; they all render the
 * same friendly empty state.
 */
export function ReminderDetailPageClient({
	preloadedDetail,
}: {
	preloadedDetail: Preloaded<
		typeof api.closer.reminderDetail.getReminderDetail
	>;
}) {
	const router = useRouter();
	const detail = usePreloadedQuery(preloadedDetail);
	usePageTitle(detail?.lead?.fullName ?? "Reminder");

	// Phase 5E — landing event. Fires once per mount when the query resolves
	// to a real reminder. Gives PostHog a funnel anchor: reminder opened →
	// outcome chosen → completed. Deliberately excludes PII (no name/phone).
	useEffect(() => {
		if (detail) {
			posthog.capture("reminder_page_opened", {
				follow_up_id: detail.followUp._id,
				opportunity_id: detail.opportunity._id,
				opportunity_status: detail.opportunity.status,
				contact_method: detail.followUp.contactMethod ?? null,
				has_phone: Boolean(detail.lead.phone),
			});
		}
		// Capture once per mount — intentionally no dependencies so we don't
		// re-emit on reactive updates.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// --- Not found / unauthorized (design doc §14.1) ------------------------
	if (detail === null) {
		return (
			<div className="flex h-full items-center justify-center">
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<AlertCircleIcon />
						</EmptyMedia>
						<EmptyTitle>Reminder Not Found</EmptyTitle>
						<EmptyDescription>
							This reminder may have been completed already or doesn&apos;t
							belong to you.
						</EmptyDescription>
						<Button
							variant="outline"
							className="mt-4"
							onClick={() => router.push("/workspace/closer")}
						>
							<ArrowLeftIcon data-icon="inline-start" />
							Back to Dashboard
						</Button>
					</EmptyHeader>
				</Empty>
			</div>
		);
	}

	const {
		followUp,
		opportunity,
		lead,
		latestMeeting,
		payments,
		paymentLinks,
	} = detail;
	const isAlreadyCompleted = followUp.status !== "pending";

	// All three Phase 5 dialogs call this on success. Having the parent own
	// navigation keeps dialogs route-agnostic; Convex reactivity has already
	// dropped the completed reminder from the dashboard's
	// `getActiveReminders` subscription, so the landing view is up to date.
	const onCompleted = () => router.push("/workspace/closer");

	return (
		<div className="flex flex-col gap-6">
			<div className="flex items-center justify-between">
				<Button variant="ghost" size="sm" onClick={() => router.back()}>
					<ArrowLeftIcon data-icon="inline-start" />
					Back
				</Button>
				{/* Urgency badge lives inside ReminderMetadataCard (design-doc
				    decision: keep the header row quiet; let the card own status). */}
			</div>

			<div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
				{/* Left column — lead identity + history */}
				<div className="flex flex-col gap-6 md:col-span-1">
					{/*
					 * LeadInfoPanel is reused as-is from the meeting detail page.
					 * `meetingHistory={[]}` because this page is reminder-centric;
					 * the panel hides the history section when the array is empty.
					 */}
					<LeadInfoPanel lead={lead} meetingHistory={[]} />
					<ReminderHistoryPanel
						latestMeeting={latestMeeting}
						payments={payments}
					/>
				</div>

				{/* Right column — contact + metadata + actions */}
				<div className="flex flex-col gap-6 md:col-span-2 lg:col-span-3">
					<ReminderContactCard followUp={followUp} lead={lead} />
					<ReminderMetadataCard
						followUp={followUp}
						opportunity={opportunity}
						latestMeeting={latestMeeting}
					/>
					<ReminderOutcomeActionBar
						followUp={followUp}
						opportunity={opportunity}
						disabled={isAlreadyCompleted}
						onCompleted={onCompleted}
					/>
					{paymentLinks.length > 0 && (
						<PaymentLinksPanel paymentLinks={paymentLinks} />
					)}
				</div>
			</div>
		</div>
	);
}
