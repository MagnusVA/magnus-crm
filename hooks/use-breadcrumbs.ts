"use client";

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
  closer: "Dashboard",
  pipeline: "Pipeline",
  team: "Team",
  settings: "Settings",
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
 * - `/workspace/closer/pipeline` → [Dashboard, Pipeline]
 * - `/workspace/closer/meetings/[id]` → [Dashboard, Meetings, <dynamic>]
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
  // so breadcrumbs start at "Dashboard", not "Home > Dashboard"
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
