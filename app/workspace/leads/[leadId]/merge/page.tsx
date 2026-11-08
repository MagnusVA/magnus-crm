import type { Id } from "@/convex/_generated/dataModel";
import { requirePermission } from "@/lib/auth";
import { MergePageClient } from "./_components/merge-page-client";

export const instant = false;

export default async function MergePage({
	params,
}: {
	params: Promise<{ leadId: string }>;
}) {
	// The same roles the merge preview and mergeLead accept.
	await requirePermission("lead:merge");
	const { leadId } = await params;

	return <MergePageClient sourceLeadId={leadId as Id<"leads">} />;
}
