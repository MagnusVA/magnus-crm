import { Suspense } from "react";
import { OpportunitiesPageClient } from "./_components/opportunities-page-client";
import { OpportunitiesPageSkeleton } from "./_components/skeletons/opportunities-page-skeleton";

export const unstable_instant = false;

export default function OpportunitiesPage() {
  return (
    <Suspense fallback={<OpportunitiesPageSkeleton />}>
      <OpportunitiesPageClient />
    </Suspense>
  );
}
