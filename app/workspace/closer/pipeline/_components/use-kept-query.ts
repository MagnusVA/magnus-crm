"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";

/**
 * `useQuery` that keeps showing its last result while new arguments load,
 * so switching a month or a filter dims the old data instead of flashing a
 * skeleton. `isStale` is true while the shown data is for older arguments.
 */
export function useKeptQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query> | "skip",
): { data: FunctionReturnType<Query> | undefined; isStale: boolean } {
  const result = useQuery(query, args);
  const [kept, setKept] = useState<FunctionReturnType<Query> | undefined>(result);
  if (result !== undefined && result !== kept) {
    setKept(result);
  }
  return { data: result ?? kept, isStale: result === undefined && kept !== undefined };
}
