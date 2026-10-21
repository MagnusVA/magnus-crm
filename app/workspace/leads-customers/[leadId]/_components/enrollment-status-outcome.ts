import { toast } from "sonner";
import {
	ENROLLMENT_STATUS_LABELS,
	type EnrollmentStatus,
} from "@/convex/enrollments/validators";

/** The toast for what `updateEnrollmentStatus` did. */
export function announceStatusOutcome(
	outcome: "changed" | "unchanged" | "stale",
	programName: string,
	status: EnrollmentStatus,
) {
	const label = ENROLLMENT_STATUS_LABELS[status];
	if (outcome === "changed") {
		toast.success(`${programName} is now ${label}`);
	} else if (outcome === "unchanged") {
		toast.info(`${programName} is already ${label}`);
	} else {
		toast.error(
			`${programName} changed since this page loaded. Check its status and try again.`,
		);
	}
}
