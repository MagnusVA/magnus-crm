import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import { OpportunitiesPageClient } from "./_components/opportunities-page-client";
import { OpportunitiesPageSkeleton } from "./_components/skeletons/opportunities-page-skeleton";

export const unstable_instant = false;

export default async function OpportunitiesPage() {
  await requirePermission("pipeline:view-own");

  return (
    <Suspense fallback={<OpportunitiesPageSkeleton />}>
      <OpportunitiesPageClient />
    </Suspense>
  );
}
