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
		uniqueProspects:
			"Distinct prospects submitted by lead gen workers in the selected range.",
		duplicates:
			"Duplicate prospect submissions recorded in the selected range.",
		leadsPerHour:
			"Submissions divided by scheduled lead gen hours across the range.",
		topWorkers:
			"Lead gen workers ranked by submission count for the selected range.",
		workerSubmissions:
			"Submission count for this worker in the selected range.",
		totalSubmissions:
			"Total lead form submissions across all workers in the selected range, not only the ranked list.",
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
			"DM closers ranked by booked-call attribution in operations rollups for the selected range.",
		scheduledCalls:
			"Booked-call volume attributed to this DM closer in operations rollups.",
		totalScheduled:
			"Total booked-call volume attributed to any DM closer, not only the ranked list.",
	},
	phoneCloserOperations: {
		section:
			"Booked-call outcomes for each assigned phone closer in operations rollups.",
		closer:
			"CRM user assigned to take the sales call.",
		bookedCalls:
			"All meetings scheduled in the range for this closer, across every status.",
		completed:
			"Meetings marked completed for this closer in the selected range.",
		noShows:
			"Meetings marked no-show for this closer in the selected range.",
		reviewRequired:
			"Meetings requiring operations review in the selected range.",
		showRate:
			"Completed calls divided by booked calls.",
		noShowRate:
			"No-show calls divided by booked calls.",
	},
	topOrigins: {
		section:
			"Top Instagram and Meta Business posts and reels ranked by submissions.",
		origin: "Source post or reel URL where the submission originated.",
		kind: "Content type for the origin — post or reel.",
		submissions:
			"Lead form submissions attributed to this post or reel in the range.",
		uniqueProspects:
			"Distinct prospects who submitted from this post or reel in the range.",
	},
} as const;
