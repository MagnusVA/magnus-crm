"use client";

import type { ReactNode } from "react";
import { InfoIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";

type OverviewHelpTooltipProps = {
	label: string;
	description: string;
	children: ReactNode;
	className?: string;
	triggerClassName?: string;
	side?: "top" | "right" | "bottom" | "left";
};

export function OverviewHelpTooltip({
	label,
	description,
	children,
	className,
	triggerClassName,
	side = "top",
}: OverviewHelpTooltipProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					className={cn(
						"inline-flex cursor-help items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
						triggerClassName,
						className,
					)}
					tabIndex={0}
					role="button"
					aria-label={`About ${label}`}
				>
					{children}
					<InfoIcon
						className="size-3 shrink-0 text-muted-foreground/80"
						aria-hidden="true"
					/>
				</span>
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

export const overviewTooltips = {
	leadGen: {
		section:
			"Lead generation form activity for the selected business date range, including worker throughput and top performers.",
		submissions:
			"Total lead form submissions recorded by lead gen workers in the range.",
		leadsPerHour:
			"Submissions divided by scheduled lead gen hours across the range.",
		topWorkers:
			"Lead gen workers ranked by submission count for the selected range.",
		workerSubmissions:
			"Submission count for this worker in the selected range.",
	},
	topQualifiers: {
		section:
			"Slack users who qualified opportunities in the selected range, ranked by qualification activity.",
		partial:
			"This range hit the Slack event cap. Rankings use the available sample only.",
		booked:
			"Distinct Slack-sourced opportunities with at least one meeting booked.",
		qualified:
			"Distinct opportunities this Slack user qualified in the range.",
		totalQualified:
			"Total distinct Slack-qualified opportunities across all qualifiers in the range.",
		conversionRate:
			"Booked opportunities divided by unique qualified opportunities.",
	},
	topDmClosers: {
		section:
			"DM closers ranked by booked calls attributed to them in the selected range.",
		bookedCalls:
			"Total booked calls attributed to this DM closer in the range.",
		showRate:
			"Completed calls divided by all booked calls attributed to this closer.",
	},
	phoneCloserOperations: {
		section:
			"Booked-call volume and commercial outcomes for each assigned phone closer in the range.",
		closer:
			"CRM user assigned to take the sales call.",
		bookedCalls:
			"All meetings scheduled in the range for this closer, across every status.",
		showRate:
			"Completed calls divided by all booked calls assigned to this closer.",
		closeRate:
			"Commissionable final payments attributed to the closer divided by calls that showed (completed or in progress).",
		cashCollected:
			"Total commissionable final payment revenue attributed to this closer. Excludes post-conversion and disputed payments.",
	},
	topOrigins: {
		section:
			"Top 10 Instagram and Meta Business posts and reels per attribution team, ranked by unique prospects.",
		team: "Attribution team assigned to the lead-gen submissions.",
		origin: "Source post or reel URL where the submission originated.",
		kind: "Content type for the origin — post or reel.",
		uniqueProspects:
			"Distinct prospects who submitted from this origin for the team in the range.",
	},
} as const;
