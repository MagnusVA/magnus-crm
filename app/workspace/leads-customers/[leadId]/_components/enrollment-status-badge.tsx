"use client";

import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import {
	ENROLLMENT_STATUS_LABELS,
	type EnrollmentStatus,
} from "@/convex/enrollments/validators";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<EnrollmentStatus, string> = {
	active: "border-stage-won/25 bg-stage-won/15 text-stage-won-ink",
	paused: "border-warning/30 bg-warning-surface text-warning-ink",
	churned: "border-stage-lost/25 bg-stage-lost/12 text-danger-ink",
};

// Passes other props through, so it can be a tooltip trigger.
export function EnrollmentStatusBadge({
	status,
	className,
	...props
}: Omit<ComponentProps<typeof Badge>, "variant" | "children"> & {
	status: EnrollmentStatus;
}) {
	return (
		<Badge variant="outline" className={cn(STATUS_CLASS[status], className)} {...props}>
			{ENROLLMENT_STATUS_LABELS[status]}
		</Badge>
	);
}
