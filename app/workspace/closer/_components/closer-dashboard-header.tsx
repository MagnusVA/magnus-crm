"use client";

import { usePreloadedQuery } from "convex/react";
import type { Preloaded } from "convex/react";
import type { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { UnmatchedBanner } from "./unmatched-banner";

/**
 * Closer dashboard header — renders the closer's name and greeting.
 *
 * Receives preloaded profile data from the parent server page.
 * Sets the document title via `usePageTitle` and conditionally shows
 * the `UnmatchedBanner` when Calendly is not linked.
 */
export function CloserDashboardHeader({
  preloadedProfile,
}: {
  preloadedProfile: Preloaded<typeof api.closer.dashboard.getCloserProfile>;
}) {
  usePageTitle("My Dashboard");
  const profile = usePreloadedQuery(preloadedProfile);

  return (
    <>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-pretty">
          My Dashboard
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Welcome back, {profile?.fullName ?? profile?.email}
        </p>
      </div>
      {!profile?.isCalendlyLinked && <UnmatchedBanner />}
    </>
  );
}
