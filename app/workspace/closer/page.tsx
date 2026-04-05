import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import { CloserDashboardPageClient } from "./_components/closer-dashboard-page-client";

export default async function CloserDashboardPage() {
  const { session } = await requireRole(["closer"]);

  const [preloadedProfile, preloadedPipelineSummary] = await Promise.all([
    preloadQuery(api.closer.dashboard.getCloserProfile, {}, {
      token: session.accessToken,
    }),
    preloadQuery(api.closer.dashboard.getPipelineSummary, {}, {
      token: session.accessToken,
    }),
  ]);

  return (
    <CloserDashboardPageClient
      preloadedProfile={preloadedProfile}
      preloadedPipelineSummary={preloadedPipelineSummary}
    />
  );
}
