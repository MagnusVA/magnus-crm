import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import { BookingReviewPageClient } from "./_components/booking-review-page-client";

export const unstable_instant = false;

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

  return <BookingReviewPageClient preloadedReview={preloadedReview} />;
}
