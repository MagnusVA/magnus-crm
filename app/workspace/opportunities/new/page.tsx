import { Suspense } from "react";
import { CreateOpportunityPageClient } from "./_components/create-opportunity-page-client";
import { CreateOpportunitySkeleton } from "./_components/create-opportunity-skeleton";

export const unstable_instant = false;

export default function CreateOpportunityPage() {
	return (
		<Suspense fallback={<CreateOpportunitySkeleton />}>
			<CreateOpportunityPageClient />
		</Suspense>
	);
}
