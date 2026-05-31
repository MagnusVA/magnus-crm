import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth";

export const unstable_instant = false;

export default async function LegacyCustomersPage() {
	await requirePermission("customer:view-own");
	redirect("/workspace/leads-customers?lifecycle=customer");
}
