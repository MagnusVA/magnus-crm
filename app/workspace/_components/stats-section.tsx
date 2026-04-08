import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { StatsRowClient } from "./stats-row-client";

/**
 * Async server component that preloads and renders admin stats.
 *
 * Wrapped in `<Suspense>` by the parent page — streams independently
 * of other dashboard sections. Uses `preloadQuery` → `usePreloadedQuery`
 * so the initial render is server-preloaded (fast) and subsequent
 * updates arrive via Convex real-time subscriptions.
 */
export async function StatsSection({ token }: { token: string }) {
  const preloadedStats = await preloadQuery(
    api.dashboard.adminStats.getAdminDashboardStats,
    {},
    { token },
  );

  return <StatsRowClient preloadedStats={preloadedStats} />;
}
