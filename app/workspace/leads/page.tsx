import { requirePermission } from "@/lib/auth";
import { LeadsPageClient } from "./_components/leads-page-client";

export const unstable_instant = false;

export default async function LeadsPage() {
	await requirePermission("lead:view-all");
	return <LeadsPageClient />;
}
