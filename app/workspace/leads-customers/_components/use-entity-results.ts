"use client";

import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useEntityBrowser } from "./entity-browser-context";

export function useEntityResults() {
	const { state } = useEntityBrowser();
	const searchTerm = state.debouncedQuery.trim();
	const lifecycle = state.lifecycle === "all" ? undefined : state.lifecycle;
	const isSearchMode = searchTerm.length > 0;

	const searchResults = useQuery(
		api.leadCustomers.queries.searchEntities,
		isSearchMode ? { searchTerm, lifecycle } : "skip",
	);

	const browse = usePaginatedQuery(
		api.leadCustomers.queries.listEntities,
		isSearchMode ? "skip" : { lifecycle: state.lifecycle },
		{ initialNumItems: 25 },
	);

	const isLoadingFirstPage = isSearchMode
		? searchResults === undefined
		: browse.status === "LoadingFirstPage";

	return {
		mode: isSearchMode ? ("search" as const) : ("browse" as const),
		filterKey: `${state.lifecycle}:${searchTerm}`,
		rows: isSearchMode ? (searchResults ?? []) : browse.results,
		isLoading: isLoadingFirstPage,
		isRefreshing:
			isLoadingFirstPage ||
			(!isSearchMode && browse.status === "LoadingMore" && browse.results.length === 0),
		canLoadMore: !isSearchMode && browse.status === "CanLoadMore",
		isLoadingMore: !isSearchMode && browse.status === "LoadingMore",
		loadMore: () => browse.loadMore(25),
	};
}
