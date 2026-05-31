import { fetchQuery } from "convex/nextjs";
import { notFound, redirect } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { requirePermission } from "@/lib/auth";

export const unstable_instant = false;

export default async function LegacyCustomerDetailPage({
	params,
}: {
	params: Promise<{ customerId: string }>;
}) {
	const { session } = await requirePermission("customer:view-own");
	const { customerId } = await params;
	let target = null;

	try {
		target = await fetchQuery(
			api.leadCustomers.redirects.resolveCustomerRedirect,
			{ customerId: customerId as Id<"customers"> },
			{ token: session.accessToken },
		);
	} catch {
		target = null;
	}

	if (!target) notFound();
	redirect(`/workspace/leads-customers/${target.leadId}`);
}
