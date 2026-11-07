import { SkeletonExit } from "@/components/page-transitions";
import { BookingReviewPageSkeleton } from "./_components/booking-review-page-skeleton";

export default function BookingReviewLoading() {
  return (
    <SkeletonExit>
      <BookingReviewPageSkeleton />
    </SkeletonExit>
  );
}
