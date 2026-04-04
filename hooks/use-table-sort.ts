"use client";

import { useMemo, useState } from "react";

export type SortDirection = "asc" | "desc" | null;

export type SortState<K extends string> = {
  key: K | null;
  direction: SortDirection;
};

/**
 * Client-side table sorting hook.
 *
 * Cycles through: null → asc → desc → null on each toggle.
 * Returns sorted data and the toggle handler.
 */
export function useTableSort<T, K extends string>(
  data: T[],
  comparators: Record<K, (a: T, b: T) => number>,
) {
  const [sort, setSort] = useState<SortState<K>>({ key: null, direction: null });

  const toggle = (key: K) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, direction: "asc" };
      if (prev.direction === "asc") return { key, direction: "desc" };
      return { key: null, direction: null }; // Reset
    });
  };

  const sorted = useMemo(() => {
    if (!sort.key || !sort.direction) return data;
    const comparator = comparators[sort.key];
    const multiplier = sort.direction === "asc" ? 1 : -1;
    return [...data].sort((a, b) => comparator(a, b) * multiplier);
  }, [data, sort, comparators]);

  return { sorted, sort, toggle };
}
