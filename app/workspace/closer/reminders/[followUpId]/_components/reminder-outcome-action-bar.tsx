"use client";

import dynamic from "next/dynamic";
import type { Doc } from "@/convex/_generated/dataModel";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { InfoIcon } from "lucide-react";
import {
	opportunityStatusConfig,
	type OpportunityStatus,
} from "@/lib/status-config";

/**
 * Lazy-load the three outcome dialogs. The dialog code is only needed
 * after the closer clicks a button, so `next/dynamic` keeps it out of
 * the initial route bundle. Mirrors `OutcomeActionBar` in the meeting
 * detail page (the canonical precedent for this pattern in the repo).
 *
 * `ssr` is left at the default (true) so the dialog trigger buttons are
 * part of the first paint — the action bar feels responsive even before
 * hydration completes.
 */
const ReminderPaymentDialog = dynamic(() =>
	import("./reminder-payment-dialog").then((m) => ({
		default: m.ReminderPaymentDialog,
	})),
);
const ReminderMarkLostDialog = dynamic(() =>
	import("./reminder-mark-lost-dialog").then((m) => ({
		default: m.ReminderMarkLostDialog,
	})),
);
const ReminderNoResponseDialog = dynamic(() =>
	import("./reminder-no-response-dialog").then((m) => ({
		default: m.ReminderNoResponseDialog,
	})),
);

type Props = {
	followUp: Doc<"followUps">;
	opportunity: Doc<"opportunities">;
	disabled: boolean;
	onCompleted: () => void;
};

/**
 * Terminal opportunity statuses where the reminder cannot meaningfully
 * resolve. Matches design doc §14.3. Keeping the list local here (rather
 * than in `lib/status-config`) makes the intent obvious at the call site:
 * "once we've landed here, the outcome is locked in".
 */
const TERMINAL_OPPORTUNITY_STATUSES = new Set<OpportunityStatus>([
	"payment_received",
	"lost",
	"no_show",
]);

/**
 * Reminder Outcome Action Bar (Phase 5A)
 *
 * Visual "traffic cop" for the three reminder outcome paths. Renders
 * one of three exhaustive branches:
 *
 *   1. **Already completed** — the follow-up is not `pending`. This
 *      happens when another tab (or another closer, if ever shared)
 *      completed the reminder; Convex reactivity re-renders us into
 *      this branch automatically.
 *   2. **Opportunity terminal** — the underlying opportunity has been
 *      won / lost / no-showed elsewhere. The reminder can no longer
 *      drive a status transition; surfaces a gentle alert instead of
 *      letting the closer trigger a mutation that would throw.
 *   3. **Actionable** — renders the three outcome dialogs. Each dialog
 *      owns its own trigger button + mutation. The bar is otherwise
 *      dumb; putting the mutations inside the dialogs keeps this
 *      component route-agnostic and trivially testable.
 *
 * The bar intentionally does not pass `opportunity` into dialogs — each
 * dialog only needs `followUpId`. Centralising the terminal-status check
 * here prevents three dialogs from diverging on the same guard rail, and
 * the Convex mutations re-validate server-side as defence in depth.
 */
export function ReminderOutcomeActionBar({
	followUp,
	opportunity,
	disabled,
	onCompleted,
}: Props) {
	// --- Branch 1: reminder already completed (design doc §14.2) --------------
	if (disabled) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Actions</CardTitle>
				</CardHeader>
				<CardContent>
					<Alert>
						<InfoIcon />
						<AlertDescription>
							This reminder has already been completed.
						</AlertDescription>
					</Alert>
				</CardContent>
			</Card>
		);
	}

	// --- Branch 2: opportunity locked in terminal state (design doc §14.3) ----
	const statusKey = opportunity.status as OpportunityStatus;
	if (TERMINAL_OPPORTUNITY_STATUSES.has(statusKey)) {
		const statusLabel =
			opportunityStatusConfig[statusKey]?.label ??
			opportunity.status.replace(/_/g, " ");
		return (
			<Card>
				<CardHeader>
					<CardTitle>Actions</CardTitle>
				</CardHeader>
				<CardContent>
					<Alert>
						<InfoIcon />
						<AlertDescription>
							The underlying opportunity is already{" "}
							<b>{statusLabel}</b>. This reminder can no longer drive a
							status change — close it from the dashboard.
						</AlertDescription>
					</Alert>
				</CardContent>
			</Card>
		);
	}

	// --- Branch 3: actionable (the happy path) -------------------------------
	return (
		<Card>
			<CardHeader>
				<CardTitle>Outcome</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-2 [&_button]:w-full">
				{/* Desirable outcome first — primary button styling pulls the eye
				    toward "log payment" without making the alternatives feel
				    punitive. */}
				<ReminderPaymentDialog
					followUpId={followUp._id}
					onSuccess={onCompleted}
				/>

				<Separator />

				{/* Fallback outcomes — both styled as outline buttons to match the
				    meeting detail bar's tertiary-action convention. */}
				<ReminderNoResponseDialog
					followUpId={followUp._id}
					leadId={followUp.leadId}
					onSuccess={onCompleted}
				/>
				<ReminderMarkLostDialog
					followUpId={followUp._id}
					onSuccess={onCompleted}
				/>
			</CardContent>
		</Card>
	);
}
