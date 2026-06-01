"use client";

import type { ReactElement, ReactNode } from "react";
import { InfoIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";

type TooltipSide = "top" | "right" | "bottom" | "left";

export function SimpleTooltip({
	content,
	children,
	side = "top",
	className,
}: {
	content: ReactNode;
	children: ReactElement;
	side?: TooltipSide;
	className?: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent
				side={side}
				sideOffset={4}
				className={cn("max-w-xs text-pretty", className)}
			>
				{content}
			</TooltipContent>
		</Tooltip>
	);
}

export function TruncatingTooltip({
	content,
	children,
	side = "top",
}: {
	content: string;
	children: ReactElement;
	side?: TooltipSide;
}) {
	return (
		<SimpleTooltip content={content} side={side}>
			{children}
		</SimpleTooltip>
	);
}

export function InfoTooltip({
	label,
	description,
	side = "top",
	className,
}: {
	label: string;
	description: string;
	side?: TooltipSide;
	className?: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					className={cn(
						"inline-flex shrink-0 items-center rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
						className,
					)}
					aria-label={`About ${label}`}
				>
					<InfoIcon className="size-3.5" aria-hidden="true" />
				</button>
			</TooltipTrigger>
			<TooltipContent
				side={side}
				sideOffset={4}
				className="max-w-xs text-pretty"
			>
				{description}
			</TooltipContent>
		</Tooltip>
	);
}

export function LabelWithInfoTooltip({
	label,
	description,
	className,
}: {
	label: ReactNode;
	description: string;
	className?: string;
}) {
	return (
		<span className={cn("inline-flex items-center gap-1", className)}>
			{label}
			<InfoTooltip label={typeof label === "string" ? label : "field"} description={description} />
		</span>
	);
}

export const leadsCustomersTooltips = {
	newSideDeal:
		"Create a manual side-deal opportunity that is not tied to a Calendly booking.",
	search:
		"Search by name, email, phone, social handle, lead ID, customer ID, or any known identifier.",
	lifecycle: {
		all: "Show both leads and converted customers.",
		lead: "People who have not yet converted to a paying customer.",
		customer: "Converted customers with a customer record and payment history.",
	},
	columns: {
		identity: "Primary display name with a secondary contact value or identifier.",
		state: "Lifecycle (lead or customer) and the current pipeline status.",
		lastSignal:
			"Most recent activity timestamp, plus the latest meeting when one exists.",
		related:
			"Linked opportunity and meeting counts, total paid when available, or open the selected opportunity.",
	},
	loadMore: "Load the next page of results for the current search and lifecycle filter.",
	openOpportunity:
		"Open this person with the selected opportunity pre-focused in the detail view.",
	relatedCounts: (opportunityCount: number, meetingCount: number) =>
		`${opportunityCount} opportunit${opportunityCount === 1 ? "y" : "ies"} and ${meetingCount} meeting${meetingCount === 1 ? "" : "s"} linked to this record.`,
	totalPaid: "Lifetime commissionable payments recorded for this customer.",
	identityChain:
		"How this person moved from lead to customer and which opportunity won the conversion.",
	customerConverted: "When this lead first became a paying customer.",
	customerTotalPaid: "Sum of recorded payments in the customer's currency.",
	customerProgram: "Program name on the winning customer record.",
	customerWinningOpportunity:
		"Opportunity that closed the sale and created the customer record.",
	listCap: (entity: string) =>
		`Only the ${entity} most recent items are loaded. Older history may exist in Convex.`,
	commissionable:
		"This payment counts toward closer commission and revenue reporting.",
	summaryOnly:
		"You can see opportunity summary here but cannot open the full opportunity workspace.",
	opportunityDetails:
		"Open the opportunity side panel with meetings, payments, and activity.",
	openMeeting: "Open the full meeting workspace in a new tab.",
	meetingClassification: "How the call was classified after it took place.",
} as const;
