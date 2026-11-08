"use client";

import { useHydrated } from "@/hooks/use-hydrated";
import { formatPaidAt } from "./billing-format";

/**
 * "Nov 3, 4:12 PM" in the viewer's browser time zone. The server renders in
 * UTC, so it shows an em dash until the page hydrates.
 */
export function PaidAt({ at, now }: { at: number; now: number }) {
  const hydrated = useHydrated();
  return hydrated ? formatPaidAt(at, now) : "—";
}
