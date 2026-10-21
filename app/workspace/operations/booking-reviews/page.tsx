import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { BookingReviewsPageClient } from "./_components/booking-reviews-page-client";
import { BookingReviewsPageSkeleton } from "./_components/booking-reviews-page-skeleton";

export const unstable_instant = false;

export default async function OperationsBookingReviewsPage() {
  await requireRole(["tenant_master", "tenant_admin"]);

  return (
    <Suspense fallback={<BookingReviewsPageSkeleton />}>
      <BookingReviewsPageClient />
    </Suspense>
  );
}
