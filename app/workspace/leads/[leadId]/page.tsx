import { requirePermission } from "@/lib/auth";
import { LeadDetailPageClient } from "./_components/lead-detail-page-client";

export const unstable_instant = false;

export default async function LeadDetailPage() {
	await requirePermission("lead:view-all");
	return <LeadDetailPageClient />;
}
