"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type LeadStatus = "active" | "converted" | "merged";

const statusConfig: Record<LeadStatus, { label: string; className: string }> = {
	active: {
		label: "Active",
		className:
			"bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900",
	},
	converted: {
		label: "Converted",
		className:
			"bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
	},
	merged: {
		label: "Merged",
		className: "bg-muted text-muted-foreground border-border",
	},
};

interface LeadStatusBadgeProps {
	status: LeadStatus;
	className?: string;
}

/**
 * Visual badge for lead status. Used in the lead list table (Phase 4)
 * and lead detail header (Phase 5).
 *
 * - Active: emerald/green — the lead is live and receiving bookings
 * - Converted: blue — the lead has been converted to a customer (Feature D)
 * - Merged: gray/muted — the lead was merged into another lead
 */
export function LeadStatusBadge({ status, className }: LeadStatusBadgeProps) {
	const config = statusConfig[status];

	return (
		<Badge variant="outline" className={cn(config.className, className)}>
			{config.label}
		</Badge>
	);
}
