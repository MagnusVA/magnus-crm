import { Suspense } from "react";
import { BookingPageSkeleton } from "../_components/booking-page-skeleton";
import { CloserLinksPageClient } from "../_components/closer-links-page-client";

export default function BookingCloserLinksPage() {
  return (
    <Suspense fallback={<BookingPageSkeleton />}>
      <CloserLinksPageClient />
    </Suspense>
  );
}
