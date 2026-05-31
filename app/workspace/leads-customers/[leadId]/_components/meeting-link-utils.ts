import type { Id } from "@/convex/_generated/dataModel";
import type { CrmRole } from "@/convex/lib/roleMapping";

export function meetingBasePathForRole(viewerRole: CrmRole) {
	return viewerRole === "closer"
		? "/workspace/closer/meetings"
		: "/workspace/pipeline/meetings";
}

export function meetingDetailHref(input: {
	meetingId: Id<"meetings">;
	viewerRole: CrmRole;
}) {
	return `${meetingBasePathForRole(input.viewerRole)}/${input.meetingId}`;
}
