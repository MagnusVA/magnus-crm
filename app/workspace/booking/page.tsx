import { Suspense } from "react";
import { CoveragePageClient } from "./_components/coverage-page-client";
import { BookingPageSkeleton } from "./_components/booking-page-skeleton";

export default function BookingCoveragePage() {
  return (
    <Suspense fallback={<BookingPageSkeleton />}>
      <CoveragePageClient />
    </Suspense>
  );
}
