"use client";

import { format } from "date-fns";
import { useHydrated } from "@/hooks/use-hydrated";

// Meeting times follow the viewer's browser time zone. The server renders in
// UTC, so these show an em dash until the page hydrates, then the local time.

const PLACEHOLDER = "—";

/** A date-fns `format` of `at` in the browser's time zone, once hydrated. */
export function LocalTime({
  at,
  pattern,
  placeholder = PLACEHOLDER,
}: {
  at: number;
  pattern: string;
  placeholder?: string;
}) {
  const hydrated = useHydrated();
  return hydrated ? format(at, pattern) : placeholder;
}

/**
 * The same as a function, for text built into a string: it returns the em
 * dash until the page hydrates.
 */
export function useLocalFormat() {
  const hydrated = useHydrated();
  return (at: number, pattern: string) => (hydrated ? format(at, pattern) : PLACEHOLDER);
}
