import { requireRole } from "@/lib/auth";
import { CloserDashboardPageClient } from "./_components/closer-dashboard-page-client";

export const unstable_instant = false;

export default async function CloserDashboardPage() {
	await requireRole(["closer"]);
	return <CloserDashboardPageClient />;
}
