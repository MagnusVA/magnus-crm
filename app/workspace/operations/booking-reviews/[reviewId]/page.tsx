import { preloadQuery } from "@/lib/convex-server-reads";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import { BookingReviewPageClient } from "./_components/booking-review-page-client";
import { ContentReveal } from "@/components/page-transitions";

export const instant = false;

export default async function BookingReviewPage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}) {
  const { session } = await requireRole(["tenant_master", "tenant_admin"]);
  const { reviewId } = await params;

  const preloadedReview = await preloadQuery(
    api.pipeline.bookingReviews.get,
    { reviewId },
    { token: session.accessToken },
  );

  return (
    <ContentReveal>
      <BookingReviewPageClient preloadedReview={preloadedReview} />
    </ContentReveal>
  );
}
