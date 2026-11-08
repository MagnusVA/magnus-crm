"use client";

import {
	useCallback,
	useMemo,
	useState,
	useTransition,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type {
	EntityBrowserContextValue,
	EntityLifecycleFilter,
} from "./entity-browser-context";
import { useDebouncedValue } from "./use-debounced-value";

function parseLifecycle(value: string | null): EntityLifecycleFilter {
	if (value === "prospect" || value === "lead" || value === "customer") return value;
	return "all";
}

function buildUrl(pathname: string, params: URLSearchParams) {
	const query = params.toString();
	return query ? `${pathname}?${query}` : pathname;
}

export function useEntityBrowserUrlState(): EntityBrowserContextValue {
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const [isPending, startTransition] = useTransition();
	const [query, setQueryState] = useState(() => searchParams.get("q") ?? "");
	const urlLifecycle = parseLifecycle(searchParams.get("lifecycle"));
	const [lifecycle, setLifecycleState] =
		useState<EntityLifecycleFilter>(urlLifecycle);
	const [syncedUrlLifecycle, setSyncedUrlLifecycle] = useState(urlLifecycle);
	const debouncedQuery = useDebouncedValue(query, 275);

	// Adopt lifecycle changes that arrive through the URL, such as back/forward.
	if (urlLifecycle !== syncedUrlLifecycle) {
		setSyncedUrlLifecycle(urlLifecycle);
		setLifecycleState(urlLifecycle);
	}

	// The filters only live in the client, so the URL is written in place
	// without a server round trip. Next keeps useSearchParams in sync.
	const replaceParams = useCallback(
		(updates: Record<string, string | null>) => {
			const next = new URLSearchParams(window.location.search);
			for (const [key, value] of Object.entries(updates)) {
				if (value === null || value.length === 0) next.delete(key);
				else next.set(key, value);
			}

			startTransition(() => {
				window.history.replaceState(null, "", buildUrl(pathname, next));
			});
		},
		[pathname],
	);

	return useMemo(
		() => ({
			state: {
				query,
				debouncedQuery,
				lifecycle,
				isSearchDebouncing: query.trim() !== debouncedQuery.trim(),
			},
			actions: {
				setQuery: (value) => {
					setQueryState(value);
					replaceParams({ q: value });
				},
				setLifecycle: (value) => {
					setLifecycleState(value);
					replaceParams({ lifecycle: value === "all" ? null : value });
				},
			},
			isPending,
		}),
		[debouncedQuery, isPending, lifecycle, query, replaceParams],
	);
}
