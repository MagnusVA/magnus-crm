"use client";

import { useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { LeadCustomerListRowDto } from "@/convex/leadCustomers/types";
import { useEntityBrowser } from "./entity-browser-context";

/** Rows a browse page loads, and how many "Show more" adds. */
export const BROWSE_PAGE = 25;
/** The most rows a search returns (convex/leadCustomers/queries.ts). */
export const SEARCH_LIMIT = 50;

type Shown = {
	key: string;
	mode: "search" | "browse";
	/** The search the rows answer; empty while browsing. */
	searchTerm: string;
	rows: LeadCustomerListRowDto[];
};

export type EntityResults = {
	mode: "search" | "browse";
	searchTerm: string;
	/** Undefined only on first load; after that the last rows stay while new ones load. */
	rows: LeadCustomerListRowDto[] | undefined;
	/** The rows shown are for an earlier tab or search (DESIGN.md, Kept Data While Reloading). */
	isStale: boolean;
	canLoadMore: boolean;
	isLoadingMore: boolean;
	/** Browsing, and every person in the tab is shown. */
	isExhausted: boolean;
	loadMore: () => void;
};

/**
 * The people for the current tab and search: a search (up to 50 matches)
 * while the field has text, else the tab's newest activity first, 25 at a
 * time. When the tab or search changes, the previous rows stay until the new
 * ones arrive.
 */
export function useEntityResults(): EntityResults {
	const { state } = useEntityBrowser();
	const searchTerm = state.debouncedQuery.trim();
	const lifecycle = state.lifecycle === "all" ? undefined : state.lifecycle;
	const isSearchMode = searchTerm.length > 0;
	const mode = isSearchMode ? ("search" as const) : ("browse" as const);
	const key = `${state.lifecycle}:${searchTerm}`;

	const searchResults = useQuery(
		api.leadCustomers.queries.searchEntities,
		isSearchMode ? { searchTerm, lifecycle } : "skip",
	);

	const browse = usePaginatedQuery(
		api.leadCustomers.queries.listEntities,
		isSearchMode ? "skip" : { lifecycle: state.lifecycle },
		{ initialNumItems: BROWSE_PAGE },
	);

	const live: LeadCustomerListRowDto[] | undefined = isSearchMode
		? searchResults
		: browse.status === "LoadingFirstPage"
			? undefined
			: browse.results;

	const [kept, setKept] = useState<Shown | null>(null);
	if (live !== undefined && (kept === null || kept.key !== key || kept.rows !== live)) {
		setKept({ key, mode, searchTerm, rows: live });
	}

	const shown: Shown | null = live !== undefined ? { key, mode, searchTerm, rows: live } : kept;
	const isStale = live === undefined && kept !== null;
	const browsing = !isSearchMode && !isStale;

	return {
		mode: shown?.mode ?? mode,
		searchTerm: shown?.searchTerm ?? searchTerm,
		rows: shown?.rows,
		isStale,
		canLoadMore: browsing && browse.status === "CanLoadMore",
		isLoadingMore: browsing && browse.status === "LoadingMore",
		isExhausted: browsing && browse.status === "Exhausted",
		loadMore: () => browse.loadMore(BROWSE_PAGE),
	};
}
