"use client";

import { usePageTitle } from "@/hooks/use-page-title";

/**
 * Dashboard header — renders immediately with no data dependency.
 *
 * Display name comes from `requireRole()` in the parent server page.
 * Sets the document title via `usePageTitle` (replaces the call that
 * previously lived in the monolithic `DashboardPageClient`).
 */
export function DashboardHeader({ displayName }: { displayName: string }) {
  usePageTitle("Dashboard");

  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
      <p className="mt-2 text-muted-foreground">
        Welcome back, {displayName}
      </p>
    </div>
  );
}
