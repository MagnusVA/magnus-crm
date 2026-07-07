"use client";

import { Badge } from "@/components/ui/badge";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Lead-level Initial Source (NIM-17): manual CTA / Inbound / WeChat
 * classification entered by DM closers in the link portal.
 */
export type LeadInitialSource = "cta" | "inbound" | "wechat";

export const INITIAL_SOURCE_META: Record<
	LeadInitialSource,
	{ label: string; className: string }
> = {
	cta: {
		label: "CTA",
		className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
	},
	inbound: {
		label: "Inbound",
		className:
			"border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
	},
	wechat: {
		label: "WeChat",
		className:
			"border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
	},
};

export function InitialSourceBadge({
	source,
	className,
}: {
	source: LeadInitialSource | null | undefined;
	className?: string;
}) {
	if (source === null || source === undefined) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<span
						className={cn(
							"cursor-default text-xs text-muted-foreground",
							className,
						)}
					>
						—
					</span>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs text-pretty">
					No initial source recorded — DM closers classify it in the DM portal.
				</TooltipContent>
			</Tooltip>
		);
	}
	const meta = INITIAL_SOURCE_META[source];
	return (
		<Badge
			variant="outline"
			className={cn("shrink-0", meta.className, className)}
		>
			{meta.label}
		</Badge>
	);
}
