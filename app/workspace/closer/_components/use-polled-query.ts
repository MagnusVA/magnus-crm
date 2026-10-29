"use client";

import { useEffect, useState } from "react";
import { useConvex } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";

export type PolledResult<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: T };

/**
 * A query that reads the clock on the server (`Date.now()`), fetched now and
 * again every `intervalMs`, so its answer moves with time. Like
 * `usePollingQuery` (hooks/use-polling-query.ts), but a failed first fetch
 * comes back as an error the section can show; a later failure keeps the
 * last answer.
 */
export function usePolledQuery<Query extends FunctionReference<"query">>(
  queryRef: Query,
  args: FunctionArgs<Query> | "skip",
  intervalMs = 60_000,
): PolledResult<FunctionReturnType<Query>> {
  const convex = useConvex();
  const [result, setResult] = useState<PolledResult<FunctionReturnType<Query>>>({
    status: "loading",
  });
  const argsKey = args === "skip" ? "skip" : JSON.stringify(args);

  useEffect(() => {
    if (args === "skip") return;
    let cancelled = false;
    const run = async () => {
      try {
        const data = await convex.query(queryRef, args);
        if (!cancelled) setResult({ status: "ready", data });
      } catch (error) {
        console.error("[CloserToday:Poll] Query failed", error);
        if (!cancelled) {
          setResult((previous) => (previous.status === "ready" ? previous : { status: "error" }));
        }
      }
    };
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [convex, queryRef, argsKey, intervalMs]); // eslint-disable-line react-hooks/exhaustive-deps

  return result;
}
