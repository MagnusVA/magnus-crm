"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import {
	ENROLLMENT_STATUS_LABELS,
	type EnrollmentStatus,
} from "@/convex/enrollments/validators";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { getErrorMessage } from "@/lib/errors";
import type { EntityDetailEnrollment } from "./entity-detail-context";
import { announceStatusOutcome } from "./enrollment-status-outcome";

const EnrollmentStatusDialog = dynamic(() =>
	import("./enrollment-status-dialog").then((module) => module.EnrollmentStatusDialog),
);

const STATUSES: EnrollmentStatus[] = ["active", "paused", "churned"];

// The status select for users with customer:edit. Paused and Churned ask for
// an optional reason first; Active applies at once. Each change carries the
// status the page shows, so a stale page changes nothing.
export function EnrollmentStatusControl({
	enrollment,
}: {
	enrollment: EntityDetailEnrollment;
}) {
	const updateStatus = useMutation(api.enrollments.mutations.updateEnrollmentStatus);
	const [pending, setPending] = useState<"paused" | "churned" | null>(null);
	const [isUpdating, setIsUpdating] = useState(false);

	const handleChange = async (value: string) => {
		const status = value as EnrollmentStatus;
		if (status === enrollment.status) return;
		if (status !== "active") {
			setPending(status);
			return;
		}
		setIsUpdating(true);
		try {
			const outcome = await updateStatus({
				enrollmentId: enrollment.enrollmentId,
				status,
				expectedStatus: enrollment.status,
			});
			announceStatusOutcome(outcome, enrollment.programName, status);
		} catch (error) {
			toast.error(getErrorMessage(error, "Couldn't change the program's status"));
		} finally {
			setIsUpdating(false);
		}
	};

	return (
		<>
			<Select value={enrollment.status} onValueChange={handleChange} disabled={isUpdating}>
				<SelectTrigger
					size="sm"
					className="w-28"
					aria-label={`Status of ${enrollment.programName}`}
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{STATUSES.map((status) => (
						<SelectItem key={status} value={status}>
							{ENROLLMENT_STATUS_LABELS[status]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{pending ? (
				<EnrollmentStatusDialog
					open
					onOpenChange={(open) => {
						if (!open) setPending(null);
					}}
					enrollment={enrollment}
					status={pending}
				/>
			) : null}
		</>
	);
}
