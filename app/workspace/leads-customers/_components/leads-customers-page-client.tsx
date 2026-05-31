"use client";

import { Suspense } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { LeadsCustomersSkeleton } from "./leads-customers-skeleton";
import { EntityBrowserProvider } from "./entity-browser-context";
import { EntityBrowserResults } from "./entity-browser-results";
import { EntityBrowserToolbar } from "./entity-browser-toolbar";
import { useEntityBrowserUrlState } from "./use-entity-browser-url-state";

function EntityBrowserShell() {
	const browser = useEntityBrowserUrlState();

	return (
		<EntityBrowserProvider value={browser}>
			<EntityBrowserToolbar />
			<EntityBrowserResults />
		</EntityBrowserProvider>
	);
}

export function LeadsCustomersPageClient() {
	usePageTitle("Leads & Customers");

	return (
		<div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
			<Suspense fallback={<LeadsCustomersSkeleton />}>
				<EntityBrowserShell />
			</Suspense>
		</div>
	);
}
