"use client";

import { usePreloadedQuery } from "convex/react";
import type { Preloaded } from "convex/react";
import type { api } from "@/convex/_generated/api";
import { StatsRow } from "./stats-row";

/**
 * Client wrapper that unwraps preloaded stats and renders StatsRow.
 */
export function StatsRowClient({
  preloadedStats,
}: {
  preloadedStats: Preloaded<typeof api.dashboard.adminStats.getAdminDashboardStats>;
}) {
  const stats = usePreloadedQuery(preloadedStats);

  if (!stats) return null;

  return <StatsRow stats={stats} />;
}
