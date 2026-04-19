"use client";

import { useState } from "react";
import {
	PhoneIcon,
	MessageSquareIcon,
	CopyIcon,
	CheckIcon,
	AlertCircleIcon,
} from "lucide-react";
import { toast } from "sonner";
import type { Doc } from "@/convex/_generated/dataModel";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

type Props = {
	followUp: Doc<"followUps">;
	lead: Doc<"leads">;
};

/**
 * Reminder Contact Card (Phase 4C)
 *
 * The visual anchor of the reminder detail page. Surfaces, in priority
 * order:
 *   1. Lead identity (name + phone, selectable for read-aloud)
 *   2. Tappable `tel:` / `sms:` CTAs (primary + secondary), plus a
 *      copy-phone fallback for desktop users without a tel handler
 *   3. The closer's "note to self" reminder text (when present)
 *
 * Accessibility:
 *   - `aria-label` includes both the contact method and the lead name so
 *     screen readers announce "Call Jane Doe at +1 555…" verbatim.
 *   - `size="lg"` shadcn buttons measure ≳48×48 CSS px — comfortably
 *     above the WCAG 2.2 AA 44×44 target-size threshold on mobile.
 *   - `tabular-nums` on the phone line makes digits read faster when
 *     dialling.
 *   - No contrast-only state: the urgency is shown in the metadata card;
 *     this card never colours its borders/buttons based on state.
 */
export function ReminderContactCard({ followUp, lead }: Props) {
	const [copied, setCopied] = useState(false);

	const phone = lead.phone?.trim() || null;
	const method = followUp.contactMethod ?? "call";
	const reminderNote = followUp.reminderNote?.trim();
	const displayName = lead.fullName?.trim() || lead.email;

	const copyPhone = async () => {
		if (!phone) return;
		try {
			await navigator.clipboard.writeText(phone);
			setCopied(true);
			toast.success("Phone number copied");
			setTimeout(() => setCopied(false), 2000);
		} catch {
			toast.error("Couldn't copy — please long-press the number");
		}
	};

	return (
		<Card>
			<CardHeader>
				<div className="flex flex-wrap items-center gap-2">
					<CardTitle>Contact</CardTitle>
					<Badge variant="secondary">
						{method === "text" ? "Text first" : "Call first"}
					</Badge>
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{/* Lead identity */}
				<div className="flex flex-col gap-1">
					<div className="text-lg font-semibold">{displayName}</div>
					{phone ? (
						<div className="text-muted-foreground text-sm tabular-nums">
							{phone}
						</div>
					) : (
						<Alert variant="destructive" className="mt-1">
							<AlertCircleIcon />
							<AlertDescription>
								No phone number on file for this lead.
							</AlertDescription>
						</Alert>
					)}
				</div>

				{/* Primary CTA row — stacked full-width on mobile, horizontal trio on ≥sm */}
				{phone && (
					<div className="flex flex-col gap-2 sm:flex-row">
						<Button
							asChild
							size="lg"
							className="flex-1"
							aria-label={`Call ${displayName} at ${phone}`}
						>
							<a href={`tel:${phone}`}>
								<PhoneIcon data-icon="inline-start" />
								Call
							</a>
						</Button>
						<Button
							asChild
							size="lg"
							variant="secondary"
							className="flex-1"
							aria-label={`Text ${displayName} at ${phone}`}
						>
							<a href={`sms:${phone}`}>
								<MessageSquareIcon data-icon="inline-start" />
								Text
							</a>
						</Button>
						<Button
							size="lg"
							variant="outline"
							onClick={copyPhone}
							aria-label={`Copy ${displayName}'s phone number`}
						>
							{copied ? (
								<>
									<CheckIcon data-icon="inline-start" />
									Copied
								</>
							) : (
								<>
									<CopyIcon data-icon="inline-start" />
									Copy
								</>
							)}
						</Button>
					</div>
				)}

				{/* Closer's reminder note — calm aside, not a CTA */}
				{reminderNote && (
					<div className="bg-muted/50 rounded-lg p-3">
						<div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
							Note to self
						</div>
						<div className="mt-1 whitespace-pre-wrap text-sm">
							{reminderNote}
						</div>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
