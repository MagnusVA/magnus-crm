import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth";

export const unstable_instant = false;

export default async function LegacyCreateOpportunityPage({
	searchParams,
}: {
	searchParams: Promise<{ leadId?: string | string[] }>;
}) {
	await requirePermission("pipeline:view-own");
	// "Create opportunity" on a lead or customer page links here with the lead
	// preselected; keep it.
	const { leadId } = await searchParams;
	const firstLeadId = Array.isArray(leadId) ? leadId[0] : leadId;
	const suffix = firstLeadId
		? `?${new URLSearchParams({ leadId: firstLeadId }).toString()}`
		: "";
	redirect(`/workspace/leads-customers/new-opportunity${suffix}`);
}
