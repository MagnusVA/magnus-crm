"use client";

import { Suspense, useCallback, useRef, type RefObject } from "react";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { SectionError } from "@/app/workspace/closer/_components/section-state";
import { DirectoryBand } from "./directory-band";
import { DirectoryResults } from "./directory-results";
import { EntityBrowserProvider, useEntityBrowser } from "./entity-browser-context";
import { LeadsCustomersSkeleton, PAGE_ROOT } from "./leads-customers-skeleton";
import { useEntityBrowserUrlState } from "./use-entity-browser-url-state";
import { SEARCH_LIMIT, useEntityResults, type EntityResults } from "./use-entity-results";

/**
 * Leads & Customers: the tenant's directory, searched first. A navy band
 * holds the search field and the lifecycle tabs (`q=` and `lifecycle=` in
 * the URL); under it, each person as one ruled row with their current deal,
 * its next step, and what they've paid.
 */
export function LeadsCustomersPageClient() {
	usePageTitle("Leads & Customers");

	return (
		<Suspense fallback={<LeadsCustomersSkeleton />}>
			<Directory />
		</Suspense>
	);
}

function Directory() {
	const browser = useEntityBrowserUrlState();
	const inputRef = useRef<HTMLInputElement>(null);

	return (
		<EntityBrowserProvider value={browser}>
			<div className={PAGE_ROOT}>
				<SectionErrorBoundary
					sectionName="leads and customers"
					fallback={
						<>
							<DirectoryBand inputRef={inputRef} summary={null} browsing />
							<div className="rounded-xl border bg-card">
								<SectionError what="people" />
							</div>
						</>
					}
				>
					<DirectoryBody inputRef={inputRef} />
				</SectionErrorBoundary>
			</div>
		</EntityBrowserProvider>
	);
}

function DirectoryBody({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
	const { state, actions } = useEntityBrowser();
	const results = useEntityResults();
	const { setting, loaded } = useBusinessDay();
	const now = useNow();
	const { setQuery } = actions;

	const clearSearch = useCallback(() => {
		setQuery("");
		inputRef.current?.focus();
	}, [setQuery, inputRef]);

	return (
		<>
			<DirectoryBand
				inputRef={inputRef}
				summary={bandSummary(state.query, state.isSearchDebouncing, results)}
				browsing={state.query.trim() === ""}
			/>
			<DirectoryResults
				results={results}
				ready={loaded}
				now={now}
				setting={setting}
				onClearSearch={clearSearch}
			/>
		</>
	);
}

/** "Newest activity first" while browsing; "3 matches for “ana”" once a search answers. */
function bandSummary(query: string, debouncing: boolean, results: EntityResults) {
	if (query.trim() === "") return "Newest activity first";
	if (debouncing || results.isStale || results.mode !== "search" || results.rows === undefined) {
		return "Searching…";
	}
	const count = results.rows.length;
	const figure = count >= SEARCH_LIMIT ? `First ${SEARCH_LIMIT} matches` : `${count} ${count === 1 ? "match" : "matches"}`;
	return `${figure} for “${results.searchTerm}”`;
}
