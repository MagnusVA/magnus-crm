import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import { CreateOpportunityPageClient } from "../../opportunities/new/_components/create-opportunity-page-client";
import { CreateOpportunitySkeleton } from "../../opportunities/new/_components/create-opportunity-skeleton";

export const unstable_instant = false;

export default async function NewLeadCustomerOpportunityPage() {
	await requirePermission("pipeline:view-own");

	return (
		<Suspense fallback={<CreateOpportunitySkeleton />}>
			<CreateOpportunityPageClient
				backHref="/workspace/leads-customers"
				backLabel="Back to Leads & Customers"
				cancelHref="/workspace/leads-customers"
				successRedirectTarget="leadCustomer"
				title="New Side Deal"
			/>
		</Suspense>
	);
}
