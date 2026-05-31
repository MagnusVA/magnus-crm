import { fetchQuery } from "convex/nextjs";
import { notFound, redirect } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { requirePermission } from "@/lib/auth";

export const unstable_instant = false;

export default async function LegacyLeadDetailPage({
	params,
}: {
	params: Promise<{ leadId: string }>;
}) {
	const { session } = await requirePermission("lead:view-all");
	const { leadId } = await params;
	let target = null;

	try {
		target = await fetchQuery(
			api.leadCustomers.redirects.resolveLeadRedirect,
			{ leadId: leadId as Id<"leads"> },
			{ token: session.accessToken },
		);
	} catch {
		target = null;
	}

	if (!target) notFound();
	redirect(`/workspace/leads-customers/${target.leadId}`);
}
