import { requirePermission } from "@/lib/auth";
import { MergePageClient } from "./_components/merge-page-client";

export const unstable_instant = false;

export default async function MergePage() {
	// The same roles the merge preview and mergeLead accept.
	await requirePermission("lead:merge");
	return <MergePageClient />;
}
