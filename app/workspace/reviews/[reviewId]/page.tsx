import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import type { Id } from "@/convex/_generated/dataModel";
import { ReviewDetailPageClient } from "./_components/review-detail-page-client";

export const unstable_instant = false;

export default async function ReviewDetailPage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}) {
  const { session } = await requireRole(["tenant_master", "tenant_admin"]);
  const { reviewId } = await params;

  const typedReviewId = reviewId as Id<"meetingReviews">;
  const preloadedDetail = await preloadQuery(
    api.reviews.queries.getReviewDetail,
    { reviewId: typedReviewId },
    { token: session.accessToken },
  );

  return <ReviewDetailPageClient preloadedDetail={preloadedDetail} />;
}
