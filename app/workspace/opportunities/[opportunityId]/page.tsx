import { Suspense } from "react";
import { fetchQuery } from "convex/nextjs";
import { notFound } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { requirePermission } from "@/lib/auth";
import { OpportunityDetailClient } from "./_components/opportunity-detail-client";
import { OpportunityDetailSkeleton } from "./_components/opportunity-detail-skeleton";

export const unstable_instant = false;

export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ opportunityId: string }>;
}) {
  const { opportunityId } = await params;
  const { session } = await requirePermission("pipeline:view-own");
  const typedOpportunityId = opportunityId as Id<"opportunities">;
  const detail = await fetchQuery(
    api.opportunities.detailQuery.getOpportunityDetail,
    { opportunityId: typedOpportunityId },
    { token: session.accessToken },
  );

  if (detail === null) {
    notFound();
  }

  return (
    <Suspense fallback={<OpportunityDetailSkeleton />}>
      <OpportunityDetailClient opportunityId={typedOpportunityId} />
    </Suspense>
  );
}
