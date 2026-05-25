import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import { CreateOpportunityPageClient } from "./_components/create-opportunity-page-client";
import { CreateOpportunitySkeleton } from "./_components/create-opportunity-skeleton";

export const unstable_instant = false;

export default async function CreateOpportunityPage() {
	await requirePermission("pipeline:view-own");

	return (
		<Suspense fallback={<CreateOpportunitySkeleton />}>
			<CreateOpportunityPageClient />
		</Suspense>
	);
}
