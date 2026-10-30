"use client";

import { createContext, useContext, useEffect } from "react";
import { usePathname } from "next/navigation";

export type BreadcrumbSegment = {
  label: string;
  href: string;
};

/**
 * Static breadcrumb label map.
 * Dynamic segments (e.g., [meetingId]) are resolved at render time
 * by the component, not the hook.
 */
const SEGMENT_LABELS: Record<string, string> = {
  workspace: "Home",
  closer: "Today",
  pipeline: "Pipeline",
  team: "Team",
  settings: "Settings",
  "lead-gen": "Lead Gen Ops",
  operations: "Operations",
  qualifications: "Qualifications",
  "booked-calls": "Booked Calls",
  attribution: "Attribution",
  "sales-calls": "Sales Calls",
  "missed-meetings": "No-shows & Cancellations",
  "leads-customers": "Leads & Customers",
  "new-opportunity": "New Side Deal",
  capture: "Capture",
  "my-activity": "My Activity",
  prospects: "Prospects",
  meetings: "Meetings",
  admin: "Admin",
};

/**
 * Derives breadcrumb segments from the current pathname.
 *
 * Rules:
 * - `/workspace` → no breadcrumbs (it's the root)
 * - `/workspace/team` → [Home, Team]
 * - `/workspace/closer` → no breadcrumbs (it's the closer root)
 * - `/workspace/closer/pipeline` → [Today, Pipeline]
 * - `/workspace/closer/meetings/[id]` → [Today, Meetings, <dynamic>]; the meeting page sets its own trail
 *
 * Dynamic segments (IDs) are returned with label "..." — the
 * consuming component should replace them with meaningful text.
 */
export function useBreadcrumbs(): BreadcrumbSegment[] {
  const pathname = usePathname();
  const parts = pathname.split("/").filter(Boolean);

  // No breadcrumbs for root pages
  if (parts.length <= 1) return [];
  if (parts.join("/") === "workspace") return [];
  if (parts.join("/") === "workspace/closer") return [];

  // For closer paths (/workspace/closer/*), skip the "workspace" prefix
  // so breadcrumbs start at "Today", not "Home > Today"
  const isCloserPath =
    parts.length >= 2 && parts[0] === "workspace" && parts[1] === "closer";
  const relevantParts = isCloserPath ? parts.slice(1) : parts;

  const segments: BreadcrumbSegment[] = [];
  // Build href accounting for the skipped prefix
  let href = isCloserPath ? "/workspace" : "";

  for (const part of relevantParts) {
    href += `/${part}`;

    if (SEGMENT_LABELS[part]) {
      segments.push({ label: SEGMENT_LABELS[part], href });
    } else {
      // Dynamic segment (e.g., meetingId) — placeholder label
      segments.push({ label: "...", href });
    }
  }

  return segments;
}

/**
 * A page's own trail, which replaces the derived one while the page is
 * mounted. Detail pages name themselves this way, such as
 * "Today › Ana Paz · Call back", where the path alone has only IDs.
 */
export type BreadcrumbTrailStore = {
  trail: BreadcrumbSegment[] | null;
  setTrail: (trail: BreadcrumbSegment[] | null) => void;
};

export const BreadcrumbTrailContext = createContext<BreadcrumbTrailStore | null>(null);

/** Sets the header's trail for this page; pass null while there's nothing to name. */
export function useBreadcrumbTrail(trail: BreadcrumbSegment[] | null) {
  const setTrail = useContext(BreadcrumbTrailContext)?.setTrail;
  // Keyed by content, so a new array with the same crumbs doesn't re-set it.
  const key = trail ? JSON.stringify(trail) : null;
  useEffect(() => {
    if (!setTrail) return;
    setTrail(key ? (JSON.parse(key) as BreadcrumbSegment[]) : null);
    return () => setTrail(null);
  }, [setTrail, key]);
}
