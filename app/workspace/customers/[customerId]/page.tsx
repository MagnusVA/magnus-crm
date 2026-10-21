import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth";

export const unstable_instant = false;

// A customer ID no longer names anything: the customers table is gone
// (docs/plans/phase-4-customers.md D1). Old links land on the customers list.
export default async function LegacyCustomerDetailPage() {
	await requirePermission("customer:view-own");
	redirect("/workspace/leads-customers?lifecycle=customer");
}
