import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth";

export const instant = false;

export default async function LegacyOpportunitiesPage() {
  await requirePermission("pipeline:view-own");
  redirect("/workspace/leads-customers");
}
