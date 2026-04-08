"use client";

import { usePreloadedQuery } from "convex/react";
import type { Preloaded } from "convex/react";
import type { api } from "@/convex/_generated/api";
import { PipelineSummary } from "./pipeline-summary";

/**
 * Client wrapper that unwraps preloaded stats and renders PipelineSummary.
 */
export function PipelineSummaryClient({
  preloadedStats,
}: {
  preloadedStats: Preloaded<typeof api.dashboard.adminStats.getAdminDashboardStats>;
}) {
  const stats = usePreloadedQuery(preloadedStats);

  if (!stats) return null;

  return <PipelineSummary stats={stats} />;
}
