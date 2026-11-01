"use client";

import type { BusinessDaySetting } from "@/lib/businessDay";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { useEntityBrowser, type EntityLifecycleFilter } from "./entity-browser-context";
import { RESULTS_ID, tabId } from "./directory-band";
import { PeopleRowsSkeleton } from "./leads-customers-skeleton";
import { PersonRow } from "./person-row";
import { BROWSE_PAGE, SEARCH_LIMIT, type EntityResults } from "./use-entity-results";

const WHO: Record<EntityLifecycleFilter, { one: string; many: string }> = {
	all: { one: "person", many: "people" },
	lead: { one: "lead", many: "leads" },
	customer: { one: "customer", many: "customers" },
	prospect: { one: "prospect", many: "prospects" },
};

const EMPTY_TAB: Record<EntityLifecycleFilter, { title: string; hint: string }> = {
	all: {
		title: "No people yet.",
		hint: "People appear here when they book through Calendly, come in from lead gen or are qualified in Slack.",
	},
	lead: {
		title: "No leads.",
		hint: "A person shows here once qualified.",
	},
	customer: {
		title: "No customers yet.",
		hint: "A person becomes a customer at their first payment.",
	},
	prospect: {
		title: "No prospects.",
		hint: "People lead gen captured who aren't qualified yet show here.",
	},
};

/**
 * The people as one white ruled card of rows, the tab's panel. First load
 * shows skeleton rows; after that a new tab or search keeps the rows shown,
 * dimmed, until its rows arrive. Browsing loads 25 more at a time.
 */
export function DirectoryResults({
	results,
	ready,
	now,
	setting,
	onClearSearch,
}: {
	results: EntityResults;
	/** The business day setting has loaded, so dates read right. */
	ready: boolean;
	now: number;
	setting: BusinessDaySetting;
	onClearSearch: () => void;
}) {
	const { state, actions } = useEntityBrowser();
	const { rows } = results;
	const dimmed = results.isStale || state.isSearchDebouncing;

	return (
		<section
			id={RESULTS_ID}
			role="tabpanel"
			aria-labelledby={tabId(state.lifecycle)}
			className="overflow-hidden rounded-xl border bg-card text-sm text-card-foreground"
		>
			{rows === undefined || !ready ? (
				<PeopleRowsSkeleton label="Loading people" />
			) : (
				<div
					aria-busy={dimmed}
					className={cn("transition-opacity duration-200", dimmed && "opacity-60")}
				>
					{rows.length === 0 ? (
						results.mode === "search" ? (
							<NoMatches
								term={results.searchTerm}
								lifecycle={state.lifecycle}
								onClearSearch={onClearSearch}
								onSearchEveryone={() => actions.setLifecycle("all")}
							/>
						) : (
							<SectionEmpty title={EMPTY_TAB[state.lifecycle].title} className="px-4 py-5 @4xl:px-[18px]">
								{EMPTY_TAB[state.lifecycle].hint}
							</SectionEmpty>
						)
					) : (
						<>
							<ul aria-label={results.mode === "search" ? "Matching people" : "People, newest activity first"}>
								{rows.map((row) => (
									<PersonRow key={row._id} row={row} now={now} setting={setting} />
								))}
							</ul>
							<footer className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t px-4 py-1.5 text-[13px] text-muted-foreground @4xl:px-[18px]">
								<span className="tabular-nums">{footerCount(results, state.lifecycle)}</span>
								{results.canLoadMore || results.isLoadingMore ? (
									<Button
										variant="outline"
										size="sm"
										disabled={results.isLoadingMore || dimmed}
										aria-busy={results.isLoadingMore}
										onClick={results.loadMore}
									>
										{results.isLoadingMore ? "Loading…" : `Show ${BROWSE_PAGE} more`}
									</Button>
								) : null}
							</footer>
						</>
					)}
				</div>
			)}
		</section>
	);
}

/** "25 shown" while more can load; "37 customers" once all are; "3 matches". */
function footerCount(results: EntityResults, lifecycle: EntityLifecycleFilter) {
	const count = results.rows?.length ?? 0;
	if (results.mode === "search") {
		return count >= SEARCH_LIMIT
			? `The first ${SEARCH_LIMIT} matches · add to the search to narrow it`
			: `${count} ${count === 1 ? "match" : "matches"}`;
	}
	if (results.isExhausted) {
		const who = WHO[lifecycle];
		return `${count} ${count === 1 ? who.one : who.many}`;
	}
	return `${count} shown`;
}

function NoMatches({
	term,
	lifecycle,
	onClearSearch,
	onSearchEveryone,
}: {
	term: string;
	lifecycle: EntityLifecycleFilter;
	onClearSearch: () => void;
	onSearchEveryone: () => void;
}) {
	const who = lifecycle === "all" ? "No one" : `No ${WHO[lifecycle].many}`;
	const hint =
		term.length < 2
			? "Type at least two letters, or a whole phone number, email or ID."
			: "Try a phone number or an email address, or check the spelling.";
	return (
		<SectionEmpty
			title={`${who} ${lifecycle === "all" ? "matches" : "match"} “${term}”.`}
			className="px-4 py-5 @4xl:px-[18px]"
		>
			<p>{hint}</p>
			<div className="mt-2.5 flex flex-wrap gap-2">
				<Button variant="outline" size="sm" onClick={onClearSearch}>
					Clear search
				</Button>
				{lifecycle !== "all" ? (
					<Button variant="ghost" size="sm" onClick={onSearchEveryone}>
						Search everyone
					</Button>
				) : null}
			</div>
		</SectionEmpty>
	);
}
