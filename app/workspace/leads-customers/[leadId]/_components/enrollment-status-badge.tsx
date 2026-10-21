"use client";

import { Badge } from "@/components/ui/badge";
import {
	ENROLLMENT_STATUS_LABELS,
	type EnrollmentStatus,
} from "@/convex/enrollments/validators";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<EnrollmentStatus, string> = {
	active: "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/25",
	paused: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/25",
	churned: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/25",
};

export function EnrollmentStatusBadge({
	status,
	className,
}: {
	status: EnrollmentStatus;
	className?: string;
}) {
	return (
		<Badge variant="outline" className={cn(STATUS_CLASS[status], className)}>
			{ENROLLMENT_STATUS_LABELS[status]}
		</Badge>
	);
}
