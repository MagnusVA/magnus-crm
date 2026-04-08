import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { PipelineSummaryClient } from "./pipeline-summary-client";

/**
 * Async server component that preloads and renders the pipeline summary.
 *
 * Wrapped in `<Suspense>` by the parent page — streams independently
 * of other dashboard sections. Calls the same `getAdminDashboardStats`
 * query as `StatsSection` (both sections derive from the aggregate stats).
 */
export async function PipelineSection({ token }: { token: string }) {
  const preloadedStats = await preloadQuery(
    api.dashboard.adminStats.getAdminDashboardStats,
    {},
    { token },
  );

  return <PipelineSummaryClient preloadedStats={preloadedStats} />;
}
