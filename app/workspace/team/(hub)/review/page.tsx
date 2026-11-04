import { Suspense } from "react";
import { ReviewPageClient } from "../../_components/review/review-page-client";
import { ReviewSkeleton } from "../../_components/review/review-skeleton";

// Team › Review. The hub's layout checks the role (tenant_master, tenant_admin).
export default function TeamReviewPage() {
  return (
    <Suspense fallback={<ReviewSkeleton />}>
      <ReviewPageClient />
    </Suspense>
  );
}
