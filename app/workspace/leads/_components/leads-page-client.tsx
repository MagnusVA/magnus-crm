"use client";

import { Suspense } from "react";
import { LeadsPageContent } from "./leads-page-content";
import { LeadsSkeleton } from "./skeletons/leads-skeleton";
import { usePageTitle } from "@/hooks/use-page-title";

export function LeadsPageClient() {
	usePageTitle("Leads");

	return (
		<Suspense fallback={<LeadsSkeleton />}>
			<LeadsPageContent />
		</Suspense>
	);
}
