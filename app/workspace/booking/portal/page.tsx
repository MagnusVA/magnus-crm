import { Suspense } from "react";
import { BookingPageSkeleton } from "../_components/booking-page-skeleton";
import { PortalPageClient } from "../_components/portal-page-client";

export default function BookingPortalPage() {
  return (
    <Suspense fallback={<BookingPageSkeleton />}>
      <PortalPageClient />
    </Suspense>
  );
}
