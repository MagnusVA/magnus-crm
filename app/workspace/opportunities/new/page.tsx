import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth";

export const unstable_instant = false;

export default async function LegacyCreateOpportunityPage() {
	await requirePermission("pipeline:view-own");
	redirect("/workspace/leads-customers/new-opportunity");
}
