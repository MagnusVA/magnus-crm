import { requirePermission } from "@/lib/auth";
import { CustomersPageClient } from "./_components/customers-page-client";

export const unstable_instant = false;

export default async function CustomersPage() {
	await requirePermission("customer:view-own");
	return <CustomersPageClient />;
}
