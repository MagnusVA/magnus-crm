"use client";

import { useEffect, useState, useCallback } from "react";
import { useConvex } from "convex/react";
import type {
	FunctionReference,
	FunctionArgs,
	FunctionReturnType,
} from "convex/server";

/**
 * One-shot Convex query with optional polling.
 *
 * Unlike `useQuery` which creates a reactive subscription,
 * this hook fetches once and optionally re-fetches on an interval.
 * Use this for queries that depend on `Date.now()` or other
 * non-deterministic inputs that Convex cannot cache.
 *
 * @param queryRef — Convex query function reference
 * @param args — Query arguments, or "skip" to disable
 * @param options.intervalMs — Polling interval in ms (0 = no polling, just one-shot)
 * @returns Data from the query, or undefined while loading. Exposes refetch for manual re-fetches.
 *
 * @example
 * // One-shot fetch on mount:
 * const data = usePollingQuery(api.foo.getBar, { id: "123" });
 *
 * // One-shot fetch with 60s polling:
 * const data = usePollingQuery(api.foo.getBar, { id: "123" }, { intervalMs: 60_000 });
 *
 * // Skip fetch (conditional):
 * const data = usePollingQuery(api.foo.getBar, user ? { id: user._id } : "skip");
 *
 * // Manual refetch (e.g., for action buttons):
 * const { data, refetch } = usePollingQuery(api.foo.getBar, { id: "123" });
 */
export function usePollingQuery<Query extends FunctionReference<"query">>(
	queryRef: Query,
	args: FunctionArgs<Query> | "skip",
	options?: { intervalMs?: number; exposeRefetch?: boolean },
): FunctionReturnType<Query> | undefined {
	const convex = useConvex();
	const [data, setData] = useState<FunctionReturnType<Query> | undefined>(
		undefined,
	);
	const intervalMs = options?.intervalMs ?? 0;

	// Stable serialized args for dependency tracking
	const argsKey = args === "skip" ? "skip" : JSON.stringify(args);

	const fetchData = useCallback(async () => {
		if (args === "skip") return;
		try {
			const result = await convex.query(queryRef, args);
			setData(result);
		} catch (err) {
			console.error(`[usePollingQuery] Failed to fetch`, err);
		}
	}, [convex, queryRef, argsKey]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		if (args === "skip") {
			setData(undefined);
			return;
		}

		let cancelled = false;

		const fetch = async () => {
			try {
				const result = await convex.query(queryRef, args);
				if (!cancelled) setData(result);
			} catch (err) {
				console.error(`[usePollingQuery] Failed to fetch`, err);
			}
		};

		void fetch();

		let interval: ReturnType<typeof setInterval> | undefined;
		if (intervalMs > 0) {
			interval = setInterval(() => void fetch(), intervalMs);
		}

		return () => {
			cancelled = true;
			if (interval) clearInterval(interval);
		};
	}, [convex, queryRef, argsKey, intervalMs]); // eslint-disable-line react-hooks/exhaustive-deps

	return data;
}
