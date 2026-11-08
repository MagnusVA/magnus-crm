import { requirePermission } from "@/lib/auth";
import { LeadsCustomersPageClient } from "./_components/leads-customers-page-client";

export const instant = false;

export default async function LeadsCustomersPage() {
	await requirePermission("lead:view-all");

	return <LeadsCustomersPageClient />;
}
