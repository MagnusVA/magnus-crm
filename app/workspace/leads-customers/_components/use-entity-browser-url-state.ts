"use client";

import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	useTransition,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
	EntityBrowserContextValue,
	EntityLifecycleFilter,
} from "./entity-browser-context";
import { useDebouncedValue } from "./use-debounced-value";

function parseLifecycle(value: string | null): EntityLifecycleFilter {
	if (value === "lead" || value === "customer") return value;
	return "all";
}

function buildUrl(pathname: string, params: URLSearchParams) {
	const query = params.toString();
	return query ? `${pathname}?${query}` : pathname;
}

export function useEntityBrowserUrlState(): EntityBrowserContextValue {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const [isPending, startTransition] = useTransition();
	const [query, setQueryState] = useState(() => searchParams.get("q") ?? "");
	const urlLifecycle = parseLifecycle(searchParams.get("lifecycle"));
	const [lifecycle, setLifecycleState] =
		useState<EntityLifecycleFilter>(urlLifecycle);
	const debouncedQuery = useDebouncedValue(query, 275);

	useEffect(() => {
		setLifecycleState(urlLifecycle);
	}, [urlLifecycle]);

	const replaceParams = useCallback(
		(updates: Record<string, string | null>) => {
			const next = new URLSearchParams(searchParams.toString());
			for (const [key, value] of Object.entries(updates)) {
				if (value === null || value.length === 0) next.delete(key);
				else next.set(key, value);
			}

			startTransition(() => {
				router.replace(buildUrl(pathname, next), { scroll: false });
			});
		},
		[pathname, router, searchParams],
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
