import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { CallInsightsPageClient } from "./_components/call-insights-page-client";
import { CallInsightsSkeleton } from "./_components/call-insights-skeleton";

export const instant = false;

/** Owners and admins only; closers are sent to their home page. */
export default async function CallInsightsPage() {
  await requireRole(["tenant_master", "tenant_admin"]);
  return (
    <Suspense fallback={<CallInsightsSkeleton />}>
      <CallInsightsPageClient />
    </Suspense>
  );
}
